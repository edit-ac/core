import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => Array.isArray(value) && value.length > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_FEATURE_FAMILIES = ['everyday-editing', 'rich-extensions', 'optional-formats', 'touch-browser', 'routes-react', 'local-persistence', 'readonly', 'collaboration-presence'];

// This authenticates existing evidence. It never runs a feature, starts a browser,
// loads host/provider code, edits receipts, or grants a qualification predicate.
export function runtimeFacts(receipt) {
  const c = receipt.counts;
  assert.ok(object(c) && Number.isSafeInteger(c.executed) && c.executed > 0, 'Missing/zero executed cases');
  for (const key of ['passed', 'failed', 'skipped']) assert.ok(Number.isSafeInteger(c[key]) && c[key] >= 0, `Invalid ${key} count`);
  assert.equal(c.failed, 0, 'Failed evidence');
  assert.equal(c.skipped, 0, 'Skipped evidence');
  for (const key of ['cancelled', 'canceled', 'todo']) assert.equal(c[key] ?? 0, 0, `Unfinished ${key} evidence`);
  assert.equal(c.passed, c.executed, 'Executed/passed count mismatch');
  assert.ok(nonempty(receipt.cases), 'Missing behavioral cases');
  const cases = receipt.cases.map(entry => {
    const id = entry.id ?? entry.name;
    assert.ok(typeof id === 'string' && id.length, 'Unnamed behavioral case');
    assert.ok(entry.passed === true || entry.status === 'passed', `Unproven case ${id}`);
    if (entry.passed !== undefined) assert.equal(entry.passed, true, `Failed case ${id}`);
    if (entry.status !== undefined) assert.equal(entry.status, 'passed', `Failed case ${id}`);
    return id;
  });
  assert.equal(new Set(cases).size, cases.length, 'Duplicate behavioral cases');
  const reused = c.reused ?? 0;
  assert.ok(Number.isSafeInteger(reused) && reused >= 0, 'Invalid reuse count');
  assert.equal(reused, 0, 'Index original executed child receipts instead of a reused aggregate');
  assert.equal(cases.length, c.executed + reused, 'Missing/unexecuted behavioral cases');
  if (c.required !== undefined) assert.equal(cases.length, c.required, 'Required case gap');
  assert.equal(receipt.exit ?? 0, 0, 'Nonzero feature exit');
  assert.notEqual(receipt.sourcesUnchanged, false, 'Sources changed during execution');
  assert.ok(nonempty(receipt.packs), 'Missing installed package pins');
  for (const pack of receipt.packs) assert.ok(pack.file && sha(pack.sha256), 'Invalid package pin');
  return { counts: c, cases, packages: receipt.packs, engine: receipt.browser?.engine ?? receipt.engine ?? receipt.profile?.engine };
}

function pinsFrom(value) {
  if (Array.isArray(value)) {
    assert.equal(new Set(value.map(pin => pin.path)).size, value.length, 'Duplicate source pin');
    return Object.fromEntries(value.map(pin => [pin.path, pin.sha256]));
  }
  assert.ok(object(value), 'Missing source pins');
  return value;
}

export async function auditLedger(ledger, root = core) {
  assert.equal(ledger.version, 1, 'Unsupported ledger version');
  assert.equal(ledger.parent, 'WFE-3.1', 'Wrong original parent');
  assert.ok(nonempty(ledger.requiredFamilies) && nonempty(ledger.features) && nonempty(ledger.proofs), 'Empty feature ledger');
  assert.deepEqual(ledger.requiredFamilies, WEB_FEATURE_FAMILIES, 'Original required feature families changed');
  assert.equal(new Set(ledger.requiredFamilies).size, ledger.requiredFamilies.length, 'Duplicate family');
  assert.equal(new Set(ledger.features.map(f => f.id)).size, ledger.features.length, 'Duplicate feature ID');
  assert.equal(new Set(ledger.proofs.map(p => p.id)).size, ledger.proofs.length, 'Duplicate proof ID');
  for (const family of ledger.requiredFamilies) assert.ok(ledger.features.some(f => f.family === family), `Missing family ${family}`);
  const fileCache = new Map();
  const bytes = async path => {
    const absolute = resolve(root, path);
    if (!fileCache.has(absolute)) fileCache.set(absolute, readFile(absolute));
    return fileCache.get(absolute);
  };
  const pinnedJSON = async pin => {
    assert.ok(pin.path && sha(pin.sha256), 'Missing evidence digest');
    const content = await bytes(pin.path);
    assert.equal(digest(content), pin.sha256, `Evidence changed: ${pin.path}`);
    return JSON.parse(content);
  };
  const checkSources = async pins => {
    const entries = Object.entries(pinsFrom(pins));
    assert.ok(entries.length, 'Empty source closure');
    const drift = [];
    for (const [path, expected] of entries) {
      assert.ok(path && sha(expected), `Invalid source pin ${path}`);
      try {
        const actual = digest(await bytes(path));
        if (actual !== expected) drift.push({ path, expected, actual });
      } catch (error) { drift.push({ path, expected, error: error.code ?? error.message }); }
    }
    return { checked: entries.length, drift };
  };
  const report = { version: 1, parent: ledger.parent, kind: 'existing-evidence-applicability', proofs: [], features: [], limits: ledger.limits };
  for (const proof of ledger.proofs) {
    const result = { id: proof.id, owner: proof.owner, command: proof.command, receipts: [], sourceChecks: [], errors: [] };
    try {
      assert.ok(nonempty(proof.receipts) && nonempty(proof.sourceManifests), 'Missing runtime/source proof');
      for (const manifest of proof.sourceManifests) {
        let value = await pinnedJSON(manifest);
        for (const key of manifest.field ?? []) value = value?.[key];
        result.sourceChecks.push({ manifest: manifest.path, ...await checkSources(value) });
      }
      for (const pin of proof.receipts) {
        const receipt = await pinnedJSON(pin);
        const facts = runtimeFacts(receipt);
        const sourceCheck = await checkSources(receipt.sources);
        const packages = [];
        for (const pack of facts.packages) {
          const path = join(pin.packageDirectory ?? dirname(pin.path), pack.file);
          assert.equal(digest(await bytes(path)), pack.sha256, `Package bytes changed/missing: ${path}`);
          packages.push({ path, sha256: pack.sha256 });
        }
        result.receipts.push({ path: pin.path, sha256: pin.sha256, ...facts, packages, sourceCheck });
      }
      // Product receipts also bind a committed SDK snapshot. Example-only pins
      // cannot authenticate a later engine or package implementation.
      if (proof.sdkRevision) {
        assert.match(proof.sdkRevision, /^[a-f0-9]{40}$/);
        const diff = spawnSync('git', ['diff', '--name-only', proof.sdkRevision, '--', 'crates', 'packages', 'Cargo.lock', 'Cargo.toml', 'package.json', 'package-lock.json', 'rust-toolchain.toml', 'scripts/build-wasm.mjs'], { cwd: root, encoding: 'utf8' });
        assert.equal(diff.status, 0, 'SDK snapshot unavailable');
        result.sdkDrift = diff.stdout.trim().split('\n').filter(Boolean);
      }
    } catch (error) { result.errors.push(error.message); }
    result.sourceCompatible = result.errors.length === 0 && !result.sdkDrift?.length && result.sourceChecks.every(s => !s.drift.length) && result.receipts.every(r => !r.sourceCheck.drift.length);
    report.proofs.push(result);
  }
  for (const feature of ledger.features) {
    assert.ok(ledger.requiredFamilies.includes(feature.family) && feature.parent === ledger.parent, `Invalid family/parent ${feature.id}`);
    assert.ok(feature.requirement && feature.oracles && feature.nextAction && nonempty(feature.apis), `Incomplete feature mapping ${feature.id}`);
    const errors = [];
    for (const api of feature.apis) {
      try {
        assert.ok(api.package && api.symbol && api.path, 'Incomplete public API reference');
        assert.ok((await bytes(api.path)).toString().includes(api.symbol), `API reference missing: ${api.symbol}`);
      } catch (error) { errors.push(error.message); }
    }
    for (const binding of feature.proofs) {
      const proof = report.proofs.find(p => p.id === binding.id);
      assert.ok(proof, `Unknown proof ${binding.id}`);
      assert.ok(nonempty(binding.cases), `Missing original case mapping ${feature.id}`);
      assert.ok(nonempty(binding.engines), `Missing required engines ${feature.id}`);
      for (const engine of binding.engines) for (const id of binding.cases) {
        const found = proof.receipts.some(r => (!engine || r.engine === engine) && r.cases.includes(id));
        if (!found) errors.push(`Unproven ${binding.id}/${engine}/${id}`);
      }
      if (!proof.sourceCompatible) errors.push(`Source-incompatible or unauthenticated ${binding.id}`);
    }
    if (feature.gap) errors.push(feature.gap);
    if (!feature.proofs.length && !feature.gap) errors.push('Missing applicable feature proof');
    report.features.push({ id: feature.id, family: feature.family, owner: feature.owner, sourceCompatible: errors.length === 0, errors, nextAction: feature.nextAction });
  }
  report.counts = { features: report.features.length, sourceCompatible: report.features.filter(f => f.sourceCompatible).length, unresolved: report.features.filter(f => !f.sourceCompatible).length, receiptsAuthenticated: report.proofs.reduce((n, p) => n + p.receipts.length, 0) };
  report.allIndexedEvidenceApplicable = report.counts.unresolved === 0;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.length === 3 || process.argv.length === 4, 'Usage: node scripts/check-web-feature-ledger.mjs OUTPUT.json [LEDGER.json]');
    const ledgerPath = resolve(process.argv[3] ?? join(core, 'fixtures/product-scenarios/web/features.json'));
    const input = await readFile(ledgerPath);
    const result = await auditLedger(JSON.parse(input));
    result.ledgerSha256 = digest(input);
    result.command = process.argv.slice(1);
    result.node = process.version;
    result.coreRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: core, encoding: 'utf8' }).stdout.trim();
    const output = resolve(process.argv[2]);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ output, ...result.counts, allIndexedEvidenceApplicable: result.allIndexedEvidenceApplicable }));
    process.exitCode = result.allIndexedEvidenceApplicable ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
