import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const workspace = fileURLToPath(new URL('../../', import.meta.url));
const core = resolve(workspace, 'core');
export const MODULES = ['slash', 'references', 'reorder', 'images', 'tables', 'math'];
export const HOSTS = ['browser', 'terminal', 'swift-ios', 'kotlin-android', 'desktop'];
export const CAPABILITIES = ['preservation', 'view', 'edit', 'copy', 'markdown', 'accessibility', 'rendering'];
const requiredProtocol = {
  preservation: ['theme-fallback', 'patch'], view: ['focus', 'selection', 'theme-fallback'],
  edit: ['focus', 'input-composition', 'selection', 'cancel-stale', 'capability-readonly'],
  copy: ['clipboard-source'], markdown: ['clipboard-source'], accessibility: ['accessibility', 'focus'],
  rendering: ['theme-fallback', 'patch', 'dispose'],
};
// These are the protocol owners, not arbitrary roadmaps containing a matching heading.
export const PLATFORM_OWNERS = {
  browser: '41-mobile-web-extensions.md', terminal: '15-tui-client.md',
  'swift-ios': '16-ios-sdk.md', 'kotlin-android': '17-android-sdk.md', desktop: '18-desktop-native.md',
};
export function requiredParity(module, host, capability) {
  if (capability === 'preservation') return 'preservation';
  if (['slash', 'reorder'].includes(module) && ['copy', 'markdown'].includes(capability)) return 'document-behavior';
  if (capability === 'markdown') return ['images', 'tables'].includes(module) ? 'document-behavior' : 'fallback';
  if (capability === 'edit' && ['images', 'math'].includes(module) || module === 'math' && capability === 'copy') return 'fallback';
  if (host === 'terminal' && !(capability === 'edit' && ['slash', 'reorder'].includes(module)) && capability !== 'copy') return 'fallback';
  return 'rich-parity';
}
export function ownerGates(module, host, capability) {
  if (host === 'browser') return ['MWX-1.8'];
  if (host === 'terminal') return ['TUI-1.11', 'TUI-1.12'];
  const prefix = { 'swift-ios': 'IOS', 'kotlin-android': 'AND', desktop: 'DSK' }[host];
  const task = capability === 'preservation' ? 4 : ['copy', 'markdown'].includes(capability) ? 13 : capability === 'accessibility' ? (['slash', 'reorder'].includes(module) ? 16 : 17) : ['slash', 'reorder'].includes(module) ? 7 : module === 'tables' ? (capability === 'edit' ? 10 : 9) : module === 'math' ? 12 : 11;
  return [`${prefix}-1.${task}`];
}
const fail = (message) => { throw new Error(message); };
const demand = (condition, message) => { if (!condition) fail(message); };
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
export function loadMatrix() { return json(resolve(core, 'fixtures/extensions/capabilities.json')); }

// Execute the schema vocabulary used by the checked-in, dependency-free v1 schema.
// Unsupported schema keywords fail closed rather than silently being ignored.
export function validateSchema(value, schema, path = '$') {
  const supported = new Set(['$schema', '$id', 'title', 'type', 'const', 'enum', 'minLength', 'pattern', 'minItems', 'uniqueItems', 'items', 'properties', 'required', 'additionalProperties']);
  for (const keyword of Object.keys(schema)) demand(supported.has(keyword), `unsupported schema keyword ${keyword}`);
  if ('const' in schema) demand(value === schema.const, `${path}: const`);
  if (schema.enum) demand(schema.enum.includes(value), `${path}: enum`);
  if (schema.type) {
    const matches = schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'array' ? Array.isArray(value) : typeof value === schema.type;
    demand(matches, `${path}: type ${schema.type}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength) demand(value.trim().length >= schema.minLength, `${path}: empty string`);
    if (schema.pattern) demand(new RegExp(schema.pattern, 'u').test(value), `${path}: pattern`);
  }
  if (Array.isArray(value)) {
    demand(value.length >= (schema.minItems ?? 0), `${path}: minItems`);
    if (schema.uniqueItems) demand(new Set(value.map(x => JSON.stringify(x))).size === value.length, `${path}: duplicate array item`);
    value.forEach((item, i) => validateSchema(item, schema.items, `${path}[${i}]`));
  } else if (schema.type === 'object') {
    for (const key of schema.required ?? []) demand(Object.hasOwn(value, key), `${path}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (property) validateSchema(item, property, `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(`${path}: unexpected ${key}`);
      else if (typeof schema.additionalProperties === 'object') validateSchema(item, schema.additionalProperties, `${path}.${key}`);
    }
  }
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');
function boundedPath(path) {
  demand(!isAbsolute(path) && /^(core|architecture)\//u.test(path) && !path.split('/').some(p => ['..', '.', ''].includes(p)) && !path.includes('\\'), `unsupported evidence path: ${path}`);
  const full = realpathSync(resolve(workspace, path));
  demand(!relative(workspace, full).startsWith('..'), `evidence escapes workspace: ${path}`);
  return full;
}
export function validateCapabilities(matrix, { read = readFileSync } = {}) {
  validateSchema(matrix, json(resolve(core, 'fixtures/extensions/capabilities.schema.json')));
  demand(sameSet(matrix.capabilities, CAPABILITIES), 'missing required capabilities');
  demand(sameSet(matrix.modules.map(m => m.id), MODULES), 'missing required modules');
  demand(sameSet(matrix.hosts.map(h => h.id), HOSTS), 'missing required hosts');
  for (const host of matrix.hosts) demand(host.roadmap === PLATFORM_OWNERS[host.id], `unsupported host owner: ${host.id}`);
  const readJSON = path => JSON.parse(read(boundedPath(path), 'utf8'));
  const baselinePath = 'architecture/evidence/modules-matrix/capabilities.json';
  const presenterPath = 'core/fixtures/extensions/presenters/conformance.json';
  const entryPath = 'core/fixtures/extensions/entry-map.json';
  const fixedInputs = [baselinePath, presenterPath, entryPath, 'core/fixtures/extensions/conformance.json', 'core/fixtures/extensions/versions/conformance.json', 'architecture/specs/extension-library.md', 'architecture/specs/extension-presenters.md', 'architecture/specs/client-contracts.md', ...Object.values(PLATFORM_OWNERS).map(p => 'architecture/roadmaps/' + p)];
  for (const path of fixedInputs) demand(Object.hasOwn(matrix.inputs, path), `missing required input: ${path}`);
  for (const [path, hash] of Object.entries(matrix.inputs)) demand(digest(read(boundedPath(path))) === hash, `input hash drift: ${path}`);
  const baseline = readJSON(baselinePath), presenters = readJSON(presenterPath), entry = readJSON(entryPath);
  demand(sameSet(presenters.hosts.map(h => h.id), HOSTS), 'presenter host coverage');
  for (const module of matrix.modules) {
    const owned = entry.modules.find(m => m.module === module.id);
    demand(module.descriptor === owned.descriptor && module.fallback === owned.fallback && sameSet(module.unsupported, owned.unsupported), `unsupported module claim: ${module.id}`);
    const source = baseline.modules.find(m => m.module === module.id);
    demand(matrix.inputs['core/' + source.source] === source.sourceSha256, `missing qualified source: ${module.id}`);
  }
  const cache = new Map();
  const receipt = path => { if (!cache.has(path)) cache.set(path, readJSON(path)); return cache.get(path); };
  for (const [id, evidence] of Object.entries(matrix.evidence)) {
    demand(digest(read(boundedPath(evidence.path))) === evidence.sha256, `evidence hash drift: ${id}`);
    if (evidence.kind === 'browser-proof') {
      const module = baseline.modules.find(m => m.module === evidence.module);
      const proof = module?.proofs.find(p => p.capability === evidence.capability && p.case === evidence.fixtureId && p.engine === evidence.engine && 'architecture/evidence/' + p.artifact === evidence.path && p.sha256 === evidence.sha256);
      demand(proof, `unsupported browser evidence: ${id}`);
      const artifact = receipt(evidence.path);
      demand(artifact.engine === evidence.engine && /^[a-f0-9]{40}$/u.test(artifact.revision), `browser revision/engine: ${id}`);
      const counts = artifact.counts;
      demand(['executed', 'passed', 'failed', 'skipped'].every(k => Number.isInteger(counts[k]) && counts[k] >= 0) && counts.executed > 0 && counts.executed === counts.passed + counts.failed + counts.skipped, `inconsistent browser receipt counts: ${id}`);
      // Upstream qualification selects named passed cases from historical receipts.
      // Their unrelated failures remain visible and do not support this cell.
      demand(artifact.cases.length === counts.executed && artifact.cases.filter(c => c.passed === true).length === counts.passed, `browser case counts: ${id}`);
      demand(artifact.cases.some(c => c.name === evidence.fixtureId && c.passed === true && c.errors.length === 0), `missing browser case: ${id}`);
      demand(artifact.sources[module.source]?.sha256 === module.sourceSha256 || artifact.sources[module.source] === module.sourceSha256, `browser source drift: ${id}`);
    } else {
      const expected = { 'portable-preservation': 'extension-contract', 'portable-codec': 'extension-codecs', 'headless-protocol': 'extension-presenters' }[evidence.kind];
      demand(evidence.path === `architecture/evidence/${expected}/receipt.json`, `unsupported receipt: ${id}`);
      const proof = receipt(evidence.path);
      demand(proof.state === 'implemented-and-verified' && /^[a-f0-9]{40}$/u.test(proof.implementationRevision), `unqualified receipt: ${id}`);
      const checks = proof.checks.filter(c => Number.isInteger(c.executed));
      demand(checks.length > 0 && checks.every(c => (c.exit ?? 0) === 0 && c.executed > 0 && c.executed === c.passed && c.failed === 0 && c.skipped === 0 && (c.cancelled ?? 0) === 0), `missing executed qualification: ${id}`);
      demand(evidence.fixturePath && Object.hasOwn(matrix.inputs, evidence.fixturePath), `missing fixture input: ${id}`);
      const pin = proof.sourceHashes[evidence.fixturePath.replace(/^core\//u, '')];
      demand((typeof pin === 'string' ? pin : pin?.sha256) === matrix.inputs[evidence.fixturePath], `receipt fixture drift: ${id}`);
      const corpus = receipt(evidence.fixturePath);
      const ids = evidence.kind === 'headless-protocol' ? corpus.hosts.find(h => h.id === evidence.host)?.fixtures : evidence.kind === 'portable-codec' ? corpus.codecCases.map(c => c.id) : corpus.cases.map(c => c.id);
      demand(ids?.includes(evidence.fixtureId), `unsupported fixture: ${id}`);
      if (evidence.kind === 'headless-protocol') demand(proof.coverage.includes(evidence.fixtureId) && evidence.fixtureId === `PRES-${evidence.host}-${evidence.obligation}`, `headless coverage: ${id}`);
      if (evidence.kind === 'portable-preservation') {
        const builtin = { references: 'builtin-reference', images: 'builtin-image', tables: 'builtin-table', math: 'builtin-math' }[evidence.module];
        demand(evidence.capability === 'preservation' && ['unknown-type', builtin].includes(evidence.fixtureId), `unsupported preservation: ${id}`);
        demand(proof.cellIds.includes(evidence.fixtureId), `missing preservation coverage: ${id}`);
      }
      if (evidence.kind === 'portable-codec') demand(evidence.capability === 'markdown' && evidence.fixtureId === ({ images: 'image-enabled', tables: 'table-enabled' })[evidence.module], `unsupported codec: ${id}`);
    }
  }
  const used = new Set(), ids = new Set();
  for (const cell of matrix.cells) {
    demand(MODULES.includes(cell.module) && HOSTS.includes(cell.host) && CAPABILITIES.includes(cell.capability), `unsupported cell: ${cell.id}`);
    demand(cell.id === `CAP-${cell.module}-${cell.host}-${cell.capability}` && !ids.has(cell.id), `duplicate or invalid cell: ${cell.id}`); ids.add(cell.id);
    const host = matrix.hosts.find(h => h.id === cell.host);
    demand(cell.required === requiredParity(cell.module, cell.host, cell.capability), `weakened parity requirement: ${cell.id}`);
    demand(sameSet(cell.owner.gates, ownerGates(cell.module, cell.host, cell.capability)), `unsupported owner gates: ${cell.id}`);
    demand(cell.owner.roadmap === host.roadmap, `wrong platform owner: ${cell.id}`);
    const roadmap = read(boundedPath('architecture/roadmaps/' + cell.owner.roadmap), 'utf8');
    for (const gate of cell.owner.gates) demand(roadmap.includes(`### Task ${gate} —`), `missing owner gate: ${cell.id}/${gate}`);
    demand(sameSet(cell.presenterFixtures, requiredProtocol[cell.capability].map(o => `PRES-${cell.host}-${o}`)), `missing presenter obligation: ${cell.id}`);
    for (const fixture of cell.presenterFixtures) { demand(matrix.evidence[fixture]?.kind === 'headless-protocol', `missing presenter fixture: ${cell.id}`); used.add(fixture); }
    const evidence = cell.evidence.map(id => { used.add(id); demand(matrix.evidence[id], `unsupported evidence reference: ${cell.id}/${id}`); return matrix.evidence[id]; });
    demand(cell.fallback.behavior === matrix.modules.find(m => m.id === cell.module).fallback, `contradictory fallback: ${cell.id}`);
    if (cell.status === 'browser-mechanics-qualified') {
      const capability = { view: 'read', rendering: 'read', edit: 'edit', copy: 'copy' }[cell.capability];
      demand(cell.host === 'browser' && capability && evidence.length > 0 && evidence.every(e => e.kind === 'browser-proof' && e.module === cell.module && e.capability === capability), `unsupported browser claim: ${cell.id}`);
      const engines = new Set(evidence.map(e => e.engine)); demand(['chromium', 'firefox', 'webkit'].every(e => engines.has(e)), `missing browser engines: ${cell.id}`);
      demand(cell.required === 'rich-parity', `contradictory browser parity: ${cell.id}`);
    } else if (cell.status === 'portable-qualified') {
      if (cell.capability === 'preservation') {
        demand(evidence.some(e => e.fixtureId === 'unknown-type'), `missing unknown preservation: ${cell.id}`);
        const builtin = { references: 'builtin-reference', images: 'builtin-image', tables: 'builtin-table', math: 'builtin-math' }[cell.module];
        if (builtin) demand(evidence.some(e => e.fixtureId === builtin), `missing built-in preservation: ${cell.id}`);
      }
      const kind = { preservation: 'portable-preservation', markdown: 'portable-codec' }[cell.capability];
      demand(kind && evidence.length > 0 && evidence.every(e => e.kind === kind && e.module === cell.module && e.capability === cell.capability), `unsupported portable claim: ${cell.id}`);
      demand(cell.required === (cell.capability === 'preservation' ? 'preservation' : 'document-behavior'), `contradictory portable parity: ${cell.id}`);
    } else {
      demand(evidence.length === 0, `unqualified status with evidence: ${cell.id}`);
      if (cell.status === 'fallback-only') demand(cell.required === 'fallback', `fallback is not rich parity: ${cell.id}`);
      if (cell.status === 'pending-platform') demand(cell.host !== 'browser' || cell.capability === 'accessibility', `unsupported pending status: ${cell.id}`);
      if (cell.status === 'document-behavior') demand(['slash', 'reorder'].includes(cell.module) && ['copy', 'markdown'].includes(cell.capability) && cell.required === 'document-behavior', `unsupported document behavior: ${cell.id}`);
    }
    if (cell.capability === 'preservation') demand(cell.status === 'portable-qualified', `unpreserved unknown data: ${cell.id}`);
    if (cell.host !== 'browser') demand(cell.status !== 'browser-mechanics-qualified', `headless is not platform parity: ${cell.id}`);
  }
  const expected = MODULES.flatMap(m => HOSTS.flatMap(h => CAPABILITIES.map(c => `CAP-${m}-${h}-${c}`)));
  demand(sameSet([...ids], expected), 'missing required module/host cells');
  // Unused evidence remains a pinned catalog; only cell-linked records support claims.
  const retainedPriorFailures = [...cache].filter(([path, proof]) => path.startsWith('architecture/evidence/modules-') && proof.counts?.failed > 0)
    .map(([path, proof]) => ({ path, ...proof.counts, unclaimedFailures: proof.cases.filter(c => c.passed !== true).map(c => c.name) }));
  return { retainedPriorFailures, cells: ids.size, modules: MODULES.length, hosts: HOSTS.length, capabilities: CAPABILITIES.length, evidenceReferences: Object.keys(matrix.evidence).length, linkedEvidence: used.size, actualPlatformEvidence: 'pending-downstream' };
}

export function renderCapabilities(matrix) {
  const labels = { 'portable-qualified': 'Portable', 'browser-mechanics-qualified': 'Browser mechanics', 'pending-platform': 'Pending', 'fallback-only': 'Fallback', 'document-behavior': 'Document' };
  let text = `# Built-in extension capabilities and parity obligations\n\nThis v1 matrix is a contract and evidence handoff. It is not a platform support announcement or package publication. The machine-readable [matrix](../../fixtures/extensions/capabilities.json) and [schema](../../fixtures/extensions/capabilities.schema.json) contain all 210 named cells, exact fixture IDs, requirements, platform gates, fallback behavior and hash-pinned evidence.\n\nRun from core with the selected Node 24.19.0 toolchain:\n\n\`\`\`sh\nnode scripts/check-extension-capabilities.mjs\nnode --test tests/extension-capabilities.test.mjs\n\`\`\`\n\nThe canonical checker rejects incomplete coverage, invalid evidence, stale hashes, absent presenter fixtures/owners and fallback claimed as rich parity. No network, provider, credential or device access is needed. Regenerate this document after an approved matrix change with \`node scripts/check-extension-capabilities.mjs --write-docs\`. Schema versions describe the matrix, not persisted module data versions.\n\n## Reading the matrix\n\nPortable means current qualified data/codec fixtures, independent of OS delivery. Browser mechanics means the existing packed production Chromium/Firefox/WebKit prepared fixtures; real-device, native IME, OS clipboard and assistive-technology observations remain pending. Pending is an explicit platform-owner obligation, including pending fallback delivery. Fallback preserves inert data/source and never satisfies a richer view/edit/rendering parity claim. Document means ordinary document copy/export for transient slash/reorder controls, which have no stored module payload or separate codec.\n\nEvery fallback preserves bounded unknown identity/payload/source. No implicit lookup, asset fetch, code/formula execution, upload or permission grant is allowed. Plain/Markdown reference labels disclose identity loss and retain typed recovery; math source does not assert typesetting or dedicated transfer support. Rich formatting transfer remains EXT-1.13. Missing renderer/codec evidence cannot be inferred from a headless protocol trace.\n\n## All host/module cells\n\nEach row maps to \`CAP-<module>-<host>-<capability>\` in the JSON. All seven cells carry concrete acceptance behavior and owner gates. Rich parity requirements remain open where status is Pending. Accessibility stays Pending even when prepared browser tests assert roles/labels: those tests are not actual AT evidence.\n\n| Module | Host | Preservation | View | Edit | Copy | Markdown | Accessibility | Rendering |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const module of MODULES) for (const host of HOSTS) text += `| ${module} | ${host} | ${CAPABILITIES.map(c => labels[matrix.cells.find(x => x.module === module && x.host === host && x.capability === c).status]).join(' | ')} |\n`;
  text += '\n## Keyboard, focus and scope\n\n';
  for (const module of matrix.modules) text += `### ${module.id}\n\n${module.keyboardFocus}\n\nFallback: ${module.fallback}.\n\nExcluded or pending: ${module.unsupported.join('; ')}.\n\n`;
  text += '## Downstream owners and fixture use\n\n';
  for (const host of matrix.hosts) {
    const gates = [...new Set(matrix.cells.filter(c => c.host === host.id).flatMap(c => c.owner.gates))].sort();
    text += `- **${host.id}**: [${host.roadmap}](../../../architecture/roadmaps/${host.roadmap}), gates ${gates.map(g => '`' + g + '`').join(', ')}. Actual platform evidence: pending.\n`;
  }
  text += '\nEach owner consumes the cell-specific `CAP-*` acceptance requirement and its linked `PRES-<host>-<obligation>` fixtures over the same atomic command, stable-selection, readonly, cancellation and disposal boundaries. Keyboard/focus behavior above applies before optional pointer/touch enhancements. Terminal source fallback is not a native table/image/math renderer; keyboard reorder remains a required pending action on every editable host. Browser ownership includes desktop browser mechanics plus mobile actual-device qualification.\n\nThe [presenter contract](../../../architecture/specs/extension-presenters.md) names the shared protocol and host resource ownership. The [built-in entry evidence](../../../architecture/evidence/extension-entry.md), [codec evidence](../../../architecture/evidence/extension-codecs.md) and [presenter evidence](../../../architecture/evidence/extension-presenters.md) retain exact implementation revisions and failed qualification history. Historical reference pre-clipboard receipts retain one failed clipboard case per engine (separately repaired upstream); historical math receipts retain one failed peer-source case per engine. Only individually passed named cases support the declared browser mechanics. The checker reports these aggregate failures and rejects failed/missing selected cases; it never treats the whole historical run as passing. Current unknown-data/codec/presenter receipt checks have zero required failures/skips.\n\nThe JSON evidence catalog binds each imported artifact and fixed corpus with SHA-256; only records linked from a cell support its claim. Future renderer/device receipts must be separately qualified by the named owners before changing status. Physical FMT-1.15 remains release-open.\n';
  return text;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const matrix = loadMatrix(), result = validateCapabilities(matrix);
    const document = resolve(core, 'docs/extensions/capabilities.md');
    if (process.argv.includes('--write-docs')) writeFileSync(document, renderCapabilities(matrix));
    else demand(readFileSync(document, 'utf8') === renderCapabilities(matrix), 'capability document drift');
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
