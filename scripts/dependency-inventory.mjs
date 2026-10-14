import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { hash } from './architecture-layers.mjs';

export const families = ['native', 'wasm', 'font', 'grammar', 'media'];
const json = value => JSON.stringify(value, null, 2) + '\n';
export function cargoLock(text) {
  return text.split(/^\[\[package\]\]$/m).slice(1).map(block => Object.fromEntries(
    ['name', 'version', 'source', 'checksum'].map(key => [key, block.match(new RegExp(`^${key} = "([^"]+)"$`, 'm'))?.[1] ?? null])
  ));
}
export function npmLock(lock) {
  assert.equal(lock.lockfileVersion, 3, 'Unsupported npm lock');
  return Object.entries(lock.packages).filter(([path, p]) => path.startsWith('node_modules/') && !p.link).map(([path, p]) => {
    assert(p.version && p.integrity && p.resolved && p.license, `Incomplete npm identity/license: ${path}`);
    return { path, name: path.split('node_modules/').at(-1), version: p.version, integrity: p.integrity, source: p.resolved, license: p.license, optional: !!p.optional, dev: !!p.dev };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
export function checkAdvisories(record, lockHashes) {
  assert.equal(record.version, 1);
  assert.deepEqual(record.locks, lockHashes, 'Advisory input drift');
  for (const ecosystem of ['npm', 'cargo', 'gradle']) {
    const result = record.sources[ecosystem];
    assert(result?.owner && result.checkedAt && result.command?.length, `Missing advisory source: ${ecosystem}`);
    if (result.state === 'unavailable') assert(result.reason && result.releaseAction, 'Unavailable advisory source requires reason and release action');
    else {
      assert.equal(result.state, 'available');
      assert(result.report && /^[a-f0-9]{64}$/.test(result.sha256));
      assert.equal(result.exit, 0, `Advisory findings/error: ${ecosystem}`);
      assert.equal(result.findings, 0, `Advisory findings: ${ecosystem}`);
    }
  }
}
export function validateInventory(inventory, policy) {
  assert.equal(inventory.version, 1);
  assert(inventory.cargo.length > 0 && inventory.npm.length > 0 && inventory.artifacts.length > 0, 'Empty inventory');
  assert(inventory.measuredArtifacts.length > 0, 'Missing measured artifact inventory');
  assert.deepEqual(Object.keys(inventory.families).sort(), [...families].sort(), 'Optional family omitted');
  assert.deepEqual(inventory.families, policy.families, 'Reviewed family scope differs');
  for (const component of inventory.cargo) assert(component.source && /^[a-f0-9]{64}$/.test(component.checksum), 'Missing Cargo checksum');
  for (const component of inventory.npm) assert(component.source && component.integrity.startsWith('sha512-'), 'Missing npm archive identity');
  assert.deepEqual(inventory.embedded.map(p => ({ ...p, notices: undefined })), policy.embedded.map(p => ({ ...p, notices: undefined })), 'Embedded component identity differs');
  for (const component of inventory.embedded) assert(component.notices.length > 0 && component.sha256 && component.revision && component.owner, 'Missing embedded component notice/identity');
  for (const component of [...inventory.cargo, ...inventory.npm, ...inventory.gradle]) {
    assert(component.version && component.owner && component.license, `Missing component identity/owner/license: ${component.name}`);
    if (component.noticeState === 'retained') assert(component.notices.length > 0 && component.notices.every(n => n.path && /^[a-f0-9]{64}$/.test(n.sha256)), 'Missing retained notice');
    else assert(component.noticeState === 'unavailable' && component.reason && !component.redistributed, `Missing notice: ${component.name}`);
    if (component.redistributed) assert.equal(component.noticeState, 'retained', `Missing distribution notice: ${component.name}`);
  }
  for (const family of families) {
    const entry = inventory.families[family];
    assert(entry.owner && entry.reason && entry.inputs.length > 0, `Missing family evidence: ${family}`);
    assert(['included', 'not-distributed', 'pending'].includes(entry.state));
    if (entry.state === 'included') assert(entry.artifacts.length > 0 && entry.components.length > 0, `Missing family artifacts: ${family}`);
    else assert.equal(entry.artifacts.length, 0, 'Pending family cannot claim artifacts');
  }
  assert.deepEqual(inventory.artifacts.map(a => a.path), policy.artifacts.map(a => a.path), 'Artifact inventory differs');
  for (let i = 0; i < inventory.artifacts.length; i++) assert.equal(inventory.artifacts[i].sha256, policy.artifacts[i].sha256, 'Artifact identity differs');
}

export async function generateInventory(root, { writeNotices = false } = {}) {
  const policy = JSON.parse(await readFile(join(root, 'licenses/policy.json')));
  const inputs = {};
  async function pin(path) {
    assert(!path.startsWith('/') && !path.split(/[\\/]/).includes('..'), 'Input must remain within repository');
    const bytes = await readFile(join(root, path)); inputs[path] = hash(bytes); return bytes;
  }
  const lockBytes = await pin('Cargo.lock'), npmBytes = await pin('package-lock.json');
  await pin('Cargo.toml'); await pin('licenses/policy.json');
  const lock = cargoLock(lockBytes.toString()), npm = npmLock(JSON.parse(npmBytes));
  const metadataResult = spawnSync('cargo', ['metadata', '--locked', '--offline', '--all-features', '--format-version', '1'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(metadataResult.status, 0, metadataResult.stderr);
  const metadata = JSON.parse(metadataResult.stdout);
  for (const pkg of metadata.packages.filter(p => !p.source)) await pin(relative(root, pkg.manifest_path));
  const notices = new Map();
  async function retain(bytes, source) {
    assert(bytes.length > 0, 'Empty notice');
    const sha256 = hash(bytes), path = `licenses/notices/${sha256}.txt`;
    notices.set(path, bytes);
    if (writeNotices) { await mkdir(join(root, 'licenses/notices'), { recursive: true }); await writeFile(join(root, path), bytes); }
    else assert.equal(hash(await readFile(join(root, path))), sha256, `Changed retained notice: ${path}`);
    return { source, path, sha256 };
  }
  const cargo = [];
  for (const pkg of metadata.packages.filter(p => p.source).sort((a, b) => a.id.localeCompare(b.id))) {
    const identity = lock.find(p => p.name === pkg.name && p.version === pkg.version && p.source === pkg.source);
    assert(identity?.checksum, `Missing Cargo lock identity: ${pkg.id}`);
    const directory = dirname(pkg.manifest_path);
    const archive = join(directory.replace('/registry/src/', '/registry/cache/'), '..', `${pkg.name}-${pkg.version}.crate`);
    assert.equal(hash(await readFile(archive)), identity.checksum, 'Cargo archive identity differs');
    function archived(file) {
      const result = spawnSync('tar', ['-xOzf', archive, `${pkg.name}-${pkg.version}/${file}`], { maxBuffer: 16 * 1024 * 1024 });
      assert.equal(result.status, 0, `Missing archived Cargo notice/manifest: ${pkg.name}/${file}`);
      return result.stdout;
    }
    assert.equal(hash(await readFile(pkg.manifest_path)), hash(archived('Cargo.toml')), 'Cargo manifest differs from locked archive');
    const files = (await readdir(directory, { withFileTypes: true })).filter(f => f.isFile() && /^(LICENSE|COPYING|NOTICE|AUTHORS)/i.test(f.name)).map(f => f.name).sort();
    const retained = [];
    for (const file of files) {
      const bytes = await readFile(join(directory, file));
      assert.equal(hash(bytes), hash(archived(file)), `Cargo notice differs from locked archive: ${pkg.name}/${file}`);
      retained.push(await retain(bytes, `cargo:${pkg.name}@${pkg.version}/${file}`));
    }
    if (!retained.length) {
      const fallback = policy.cargoNoticeFallbacks[`${pkg.name}@${pkg.version}`];
      assert(fallback, `Missing Cargo notice: ${pkg.name}@${pkg.version}`);
      const vcs = JSON.parse(archived('.cargo_vcs_info.json'));
      assert.equal(vcs.git.sha1, fallback.revision, 'Fallback notice upstream revision differs');
      const bytes = await pin(fallback.path);
      assert.equal(hash(bytes), fallback.sha256, 'Fallback notice differs');
      retained.push(await retain(bytes, fallback.source));
    }
    assert(pkg.license, `Missing Cargo license: ${pkg.name}`);
    cargo.push({ ...identity, license: pkg.license, owner: policy.owners.cargo, redistributed: true, scope: 'conservative all-features runtime/build closure; not platform qualification', noticeState: 'retained', notices: retained });
  }
  assert.equal(cargo.length, lock.filter(p => p.source).length, 'Cargo lock coverage differs');
  const embedded = [];
  for (const entry of policy.embedded) {
    const pkg = metadata.packages.find(p => p.name === entry.container && p.version === entry.containerVersion);
    assert(pkg, 'Missing embedded component container');
    const directory = dirname(pkg.manifest_path), archive = join(directory.replace('/registry/src/', '/registry/cache/'), '..', `${pkg.name}-${pkg.version}.crate`);
    const result = spawnSync('tar', ['-xOzf', archive, `${pkg.name}-${pkg.version}/${entry.file}`], { maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, 'Missing embedded component source');
    assert.equal(hash(result.stdout), entry.sha256, 'Embedded component source drift');
    const text = result.stdout.toString();
    assert(text.includes(entry.revision) && text.includes(`"${entry.version}"`), 'Embedded component revision differs');
    const notice = await pin(entry.noticeSource);
    assert(text.includes(notice.toString()), 'Embedded notice differs from exact archive source');
    embedded.push({ ...entry, notices: [await retain(notice, `cargo:${pkg.name}@${pkg.version}/${entry.file}`)] });
  }
  const cacheResult = spawnSync('npm', ['config', 'get', 'cache'], { cwd: root, encoding: 'utf8' });
  assert.equal(cacheResult.status, 0, 'Cannot locate npm artifact cache');
  const npmCache = cacheResult.stdout.trim();
  for (const pkg of npm) {
    pkg.owner = policy.owners.npm;
    pkg.redistributed = policy.redistributedNpm.includes(pkg.name);
    pkg.scope = pkg.redistributed ? 'bundled optional renderer' : 'tooling, fixture or host-supplied peer; not bundled by SDK';
    pkg.notices = [];
    const directory = join(root, pkg.path);
    try {
      const installed = JSON.parse(await readFile(join(directory, 'package.json')));
      assert.equal(installed.version, pkg.version, 'Installed npm version differs');
      const match = pkg.integrity.match(/^(sha512)-([A-Za-z0-9+/=]+)$/);
      assert(match, 'Unsupported npm integrity');
      const digest = Buffer.from(match[2], 'base64').toString('hex');
      const archive = join(npmCache, '_cacache/content-v2', match[1], digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
      const bytes = await readFile(archive);
      assert.equal(createHash(match[1]).update(bytes).digest('base64'), match[2], 'npm archive integrity differs');
      const files = (await readdir(directory, { withFileTypes: true })).filter(f => f.isFile() && /^(LICENSE|COPYING|NOTICE)/i.test(f.name)).map(f => f.name).sort();
      const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      assert.equal(listing.status, 0, `Unreadable npm archive: ${pkg.name}`);
      const manifests = listing.stdout.split('\n').filter(p => p.split('/').length === 2 && p.split('/')[1] === 'package.json');
      assert.equal(manifests.length, 1, `Missing npm archive manifest: ${pkg.name}`);
      const manifest = spawnSync('tar', ['-xOzf', archive, manifests[0]], { maxBuffer: 16 * 1024 * 1024 });
      assert.equal(manifest.status, 0);
      assert.equal(hash(manifest.stdout), hash(await readFile(join(directory, 'package.json'))), `Installed npm manifest drift: ${pkg.name}`);
      for (const file of files) {
        const entries = listing.stdout.split('\n').filter(p => p.split('/').length === 2 && p.split('/')[1] === file);
        assert.equal(entries.length, 1, `Missing npm archive notice: ${pkg.name}/${file}`);
        const extracted = spawnSync('tar', ['-xOzf', archive, entries[0]], { maxBuffer: 16 * 1024 * 1024 });
        assert.equal(extracted.status, 0, `Missing npm archive notice: ${pkg.name}/${file}`);
        assert.equal(hash(extracted.stdout), hash(await readFile(join(directory, file))), 'npm notice differs from locked archive');
        pkg.notices.push(await retain(extracted.stdout, `npm:${pkg.name}@${pkg.version}/${file}`));
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    pkg.noticeState = pkg.notices.length ? 'retained' : 'unavailable';
    if (!pkg.notices.length) pkg.reason = 'No local distributed notice text (uninstalled target package or omitted upstream text); release owner must resolve before bundling';
  }
  for (const name of policy.redistributedNpm) assert(npm.some(p => p.name === name && p.noticeState === 'retained'), `Missing bundled npm notices: ${name}`);
  const gradle = [];
  for (const path of policy.gradleLocks) {
    const bytes = await pin(path);
    for (const line of bytes.toString().split('\n').filter(l => l && !l.startsWith('#') && !l.startsWith('empty='))) {
      const match = line.match(/^([^:]+):([^:]+):([^=]+)=(.+)$/);
      assert(match, `Invalid Gradle lock entry: ${line}`);
      gradle.push({ name: `${match[1]}:${match[2]}`, version: match[3], configurations: match[4].split(','), lock: path, owner: policy.owners.native, license: 'unqualified: owning Android release inventory required', redistributed: false, noticeState: 'unavailable', notices: [], reason: 'Probe only; no released Android SDK artifact. Owning platform must retain JAR/POM license notices before distribution.' });
    }
  }
  const artifacts = [];
  for (const entry of policy.artifacts) {
    assert(!entry.path.includes('..') && !resolve(root, entry.path).startsWith(root + '/licenses/notices/'), 'Unsafe artifact path');
    const bytes = await pin(entry.path);
    assert.equal(hash(bytes), entry.sha256, `Artifact drift: ${entry.path}`);
    artifacts.push({ ...entry, bytes: bytes.length });
  }
  const measuredArtifacts = [];
  for (const path of policy.measuredManifests) {
    const manifest = JSON.parse(await pin(path));
    assert(manifest.required.length > 0 && manifest.assets.length > 0, 'Empty measured artifact manifest');
    assert.deepEqual(manifest.required.map(a => a.name).sort(), manifest.assets.map(a => a.name).sort(), 'Measured manifest coverage differs');
    for (const asset of manifest.assets) {
      assert(!asset.name.includes('..') && !asset.name.startsWith('/'), 'Unsafe measured artifact path');
      const assetPath = join(dirname(path), 'artifacts', asset.name), bytes = await pin(assetPath);
      assert.equal(hash(bytes), asset.sha256, 'Measured artifact hash differs');
      measuredArtifacts.push({ path: assetPath, manifest: path, kind: asset.kind, sha256: hash(bytes), bytes: bytes.length });
    }
  }
  const familyRecords = structuredClone(policy.families);
  for (const family of Object.values(familyRecords)) {
    for (const path of family.inputs) await pin(path);
    for (const path of family.artifacts) assert(artifacts.some(a => a.path === path), 'Uninventoried optional artifact');
    for (const name of family.components) assert([...cargo, ...npm].some(p => p.name === name && p.noticeState === 'retained'), 'Uninventoried family component');
  }
  // Check notice payloads inside actual packed distributions, not just source files.
  for (const archive of policy.distributions) {
    const listing = spawnSync('tar', ['-tzf', archive.path], { cwd: root, encoding: 'utf8' });
    assert.equal(listing.status, 0, 'Packed distribution unreadable');
    for (const font of listing.stdout.split('\n').filter(p => /\.(woff2?|ttf|otf)$/.test(p))) assert(policy.families.font.state === 'included' && archive.assets.some(a => a.entry === font), 'Uninventoried font asset: review font family admission');
    for (const asset of archive.assets) {
      assert(listing.stdout.split('\n').includes(asset.entry), `Missing packed artifact: ${asset.entry}`);
      const result = spawnSync('tar', ['-xOzf', archive.path, asset.entry], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(result.status, 0, 'Packed artifact unreadable');
      assert.equal(hash(result.stdout), hash(await pin(asset.source)), 'Packed artifact/source drift');
    }
    for (const notice of archive.notices) {
      assert(listing.stdout.split('\n').includes(notice.entry), `Missing packed notice: ${notice.entry}`);
      const extraction = spawnSync('tar', ['-xOzf', archive.path, notice.entry], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(extraction.status, 0);
      const source = await pin(notice.source);
      assert.equal(hash(extraction.stdout), hash(source), `Packed notice/source drift: ${notice.entry}`);
    }
  }
  const wasmResult = spawnSync('cargo', ['metadata', '--locked', '--offline', '--filter-platform', 'wasm32-unknown-unknown', '--format-version', '1'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(wasmResult.status, 0, wasmResult.stderr);
  const wasmMetadata = JSON.parse(wasmResult.stdout), nodes = new Map(wasmMetadata.resolve.nodes.map(n => [n.id, n]));
  for (const [name, path] of Object.entries(policy.wasmNoticeRoots)) {
    const rootPackage = wasmMetadata.packages.find(p => p.name === name);
    assert(rootPackage, 'Unknown WASM notice root');
    const seen = new Set(), todo = [rootPackage.id], text = (await pin(path)).toString();
    while (todo.length) {
      const id = todo.pop(); if (seen.has(id)) continue; seen.add(id);
      todo.push(...nodes.get(id).dependencies);
      const pkg = wasmMetadata.packages.find(p => p.id === id);
      if (!pkg.source) continue;
      assert(text.includes(`${pkg.name} ${pkg.version} — ${pkg.license}`), `Missing WASM dependency notice: ${pkg.name}`);
      const record = cargo.find(p => p.name === pkg.name && p.version === pkg.version);
      for (const notice of record.notices.filter(n => !n.source.endsWith('/AUTHORS'))) assert(text.includes(notices.get(notice.path).toString()), `Missing WASM license text: ${pkg.name}`);
    }
  }
  const advisoryBytes = await pin('licenses/advisories.json'), advisories = JSON.parse(advisoryBytes);
  checkAdvisories(advisories, { cargo: hash(lockBytes), npm: hash(npmBytes) });
  for (const [ecosystem, result] of Object.entries(advisories.sources)) if (result.report) {
    const bytes = await pin(result.report);
    assert.equal(hash(bytes), result.sha256, 'Advisory report drift');
    if (ecosystem === 'npm') {
      const report = JSON.parse(bytes);
      assert(!report.error && report.metadata.dependencies.total > 0, 'Incomplete npm advisory response');
      assert.equal(report.metadata.vulnerabilities.total, result.findings, 'Reported npm advisory count differs');
      assert.equal(Object.keys(report.vulnerabilities).length, result.findings, 'npm advisory findings omitted');
    }
  }
  const inventory = { version: 1, scope: policy.scope, inputs, cargo, npm, gradle, embedded, artifacts, measuredArtifacts, families: familyRecords, advisories, noticeCount: notices.size };
  validateInventory(inventory, policy);
  return inventory;
}

export async function writeInventory(root) {
  const inventory = await generateInventory(root, { writeNotices: true });
  await writeFile(join(root, 'licenses/inventory.json'), json(inventory));
  return inventory;
}
export async function checkInventory(root) {
  const inventory = await generateInventory(root);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'licenses/inventory.json'))), inventory, 'Inventory stale; regenerate and review');
  return inventory;
}
