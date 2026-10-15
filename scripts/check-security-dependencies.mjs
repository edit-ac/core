// Live public dependency metadata/advisories only; never calls an AI provider.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseActiveTree, affectedAdvisories } from './security-dependency-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 4 || process.argv[2] !== '--evidence') throw new Error('Use --evidence DIRECTORY');
const dir = path.resolve(process.argv[3]);
mkdirSync(dir, { recursive: true });
const args = ['run', '1.97.1', 'cargo', 'metadata', '--locked', '--format-version', '1', '--features', 'editac-security/protocol-probe'];
const result = spawnSync(process.env.RUSTUP ?? 'rustup', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
writeFileSync(path.join(dir, 'dependency-metadata.log'), result.stderr ?? '');
if (result.status !== 0 || result.error) throw new Error('Locked dependency metadata failed');
writeFileSync(path.join(dir, 'dependency-metadata.json'), result.stdout);
const metadata = JSON.parse(result.stdout);
const start = metadata.packages.find(pkg => pkg.name === 'editac-security');
if (!start) throw new Error('Security package missing');
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
// Unfiltered metadata includes inactive optional/cfg dependencies. Query the real
// normal/build graph for every intended target, including host proc macros.
const targets = JSON.parse(readFileSync(path.join(root, 'scripts/security-targets.json'))).targets;
if (!targets?.length) throw new Error('Empty target set');
const active = new Set();
for (const { id } of targets) {
  const tree = spawnSync(process.env.RUSTUP ?? 'rustup', ['run', '1.97.1', 'cargo', 'tree', '--locked',
    '--package', 'editac-security', '--no-default-features', '--features', 'protocol-probe',
    '--target', id, '--edges', 'normal,build', '--prefix', 'none', '--format', '{p}'],
  { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
  writeFileSync(path.join(dir, `dependencies-${id}.txt`), `${tree.stdout ?? ''}\n${tree.stderr ?? ''}`);
  if (tree.status !== 0 || tree.error) throw new Error(`Active dependency graph failed: ${id}`);
  for (const pkg of parseActiveTree(tree.stdout)) active.add(pkg);
}
const packages = metadata.packages.filter(pkg => active.has(`${pkg.name}@${pkg.version}`)).map(pkg => ({
  name: pkg.name, version: pkg.version, license: pkg.license, source: pkg.source,
  features: nodes.get(pkg.id).features,
  licenseFiles: readdirSync(path.dirname(pkg.manifest_path)).filter(name => /^(license|copying)([.-]|$)/i.test(name)).map(name => ({
    name, sha256: createHash('sha256').update(readFileSync(path.join(path.dirname(pkg.manifest_path), name))).digest('hex'),
  })),
})).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
if (packages.length !== active.size) throw new Error('Active graph contains unidentified packages');
// Pin omitted license texts and their origins using exact package/version keys.
const licenseSources = JSON.parse(readFileSync(path.join(root, 'scripts/licenses/security-license-sources.json')));
for (const pkg of packages) {
  if (!pkg.licenseFiles.length) {
    const source = licenseSources[`${pkg.name}@${pkg.version}`];
    if (source) {
      const sha256 = createHash('sha256').update(readFileSync(path.join(root, source.file))).digest('hex');
      if (source.license !== pkg.license || sha256 !== source.sha256) throw new Error(`Pinned license mismatch: ${pkg.name}`);
      pkg.licenseFiles.push({ name: source.file, sha256, url: source.url });
    }
  }
}
const disallowedFeatures = ['crypto-debug', 'content-debug', 'test-utils', 'libcrux-provider'];
const unsafeFeatures = packages.filter(pkg => pkg.name === 'openmls' && pkg.features.some(feature => disallowedFeatures.includes(feature)));
// Explicit reviewed SPDX expressions; new expressions fail closed for review.
const licenses = new Set(['Apache-2.0', 'MIT', 'MIT OR Apache-2.0', 'Apache-2.0 OR MIT', 'BSD-3-Clause',
  'BSD-2-Clause', 'ISC', 'Unicode-3.0', 'Zlib', 'Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT',
  '(MIT OR Apache-2.0) AND Unicode-3.0', 'MIT OR Apache-2.0 OR Zlib',
  'Unlicense OR MIT', 'Apache-2.0/MIT', 'MIT/Apache-2.0', 'MIT OR Apache-2.0 OR BSD-1-Clause',
  'MPL-2.0', 'MIT OR Apache-2.0 OR LGPL-2.1-or-later', 'BSD-2-Clause OR Apache-2.0 OR MIT']);
const licenseProblems = packages.filter(pkg => !licenses.has(pkg.license) || !pkg.licenseFiles.length);
const queries = packages.filter(pkg => pkg.source?.startsWith('registry+')).map(pkg => ({
  package: { ecosystem: 'crates.io', name: pkg.name }, version: pkg.version,
}));
writeFileSync(path.join(dir, 'dependency-inventory.json'), `${JSON.stringify({ packages, licenseProblems, unsafeFeatures, queries }, null, 2)}\n`);
if (!queries.length) throw new Error('Empty dependency advisory query');
let advisoryError = null;
let affected = [];
try {
  const response = await fetch('https://api.osv.dev/v1/querybatch', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries }), signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`OSV returned ${response.status}`);
  const body = await response.json();
  writeFileSync(path.join(dir, 'osv-response.json'), `${JSON.stringify(body, null, 2)}\n`);
  affected = affectedAdvisories(body, queries);
} catch (error) { advisoryError = error.message; }
const receipt = { checkedAt: new Date().toISOString(), scope: 'Active normal/build security dependencies across ten declared targets, including host proc macros; not a security review',
  packages: packages.length, advisoryQueries: queries.length, licenseProblems, unsafeFeatures, affected, advisoryError,
  lockSha256: createHash('sha256').update(readFileSync(path.join(root, 'Cargo.lock'))).digest('hex'),
  exit: licenseProblems.length || unsafeFeatures.length || affected.length || advisoryError ? 1 : 0 };
writeFileSync(path.join(dir, 'dependencies-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ packages: receipt.packages, advisoryQueries: receipt.advisoryQueries,
  licenseProblems: licenseProblems.length, unsafeFeatures: unsafeFeatures.length, affected: affected.length,
  advisoryError, exit: receipt.exit, receipt: path.join(dir, 'dependencies-receipt.json') }));
process.exitCode = receipt.exit;
