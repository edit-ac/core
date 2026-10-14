import { readFile, readdir, realpath } from 'node:fs/promises';
import { relative, resolve, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';

const portable = path => path.split(sep).join('/');
const fail = message => { throw Error(message); };
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function validatePolicy(policy) {
  if (policy.version !== 1) fail('Unknown layer manifest version');
  if (!policy.components?.length || !policy.minimumCargoRoots?.length) fail('Empty layer ownership');
  const names = new Set(), paths = new Set();
  for (const component of policy.components) {
    if (!['cargo', 'js'].includes(component.ecosystem) || !component.name || !component.layer ||
        !component.manifest || !Array.isArray(component.allowedInternal) || !Array.isArray(component.allowedExternal)) fail('Invalid component');
    if (names.has(component.name) || paths.has(component.manifest)) fail('Duplicate component ownership');
    names.add(component.name); paths.add(component.manifest);
  }
  for (const component of policy.components) for (const name of component.allowedInternal) {
    if (!names.has(name)) fail(`Unknown companion ${name}`);
  }
  for (const name of policy.minimumCargoRoots) if (!names.has(name)) fail(`Unknown minimum root ${name}`);
  if (!policy.minimumCargoExternal?.length) fail('Empty minimum dependency inventory');
}

function assertEdge(component, name, components, context) {
  if (name === component.name) return;
  const allowed = components.has(name) ? component.allowedInternal : component.allowedExternal;
  if (!allowed.includes(name)) fail(`Forbidden layer edge ${component.name} -> ${name} (${context})`);
}

export function cargoGraph(metadata, policy) {
  validatePolicy(policy);
  if (!metadata.packages?.length || !metadata.resolve?.nodes?.length || !metadata.workspace_members?.length) fail('Empty Cargo graph');
  const components = new Map(policy.components.map(c => [c.name, c]));
  const packages = new Map(metadata.packages.map(p => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]));
  const edges = [], devEdges = [];
  for (const id of metadata.workspace_members) {
    const pkg = packages.get(id), component = components.get(pkg?.name);
    if (!component || component.ecosystem !== 'cargo') fail(`Unowned Cargo member ${pkg?.name ?? id}`);
    if (portable(relative(metadata.workspace_root, pkg.manifest_path)) !== component.manifest) fail(`Cargo owner path mismatch ${pkg.name}`);
    for (const declaration of pkg.dependencies ?? []) {
      if (declaration.kind === 'dev') continue;
      assertEdge(component, declaration.name, components, 'Cargo declaration (including disabled optional)');
    }
    const node = nodes.get(id);
    if (!node) fail(`Missing resolved Cargo node ${id}`);
    for (const dep of node.deps) {
      const target = packages.get(dep.pkg);
      if (!target || !dep.dep_kinds?.length) fail(`Incomplete Cargo edge ${id}`);
      for (const kind of dep.dep_kinds) {
        const edge = { from: pkg.name, to: target.name, kind: kind.kind ?? 'normal', target: kind.target };
        if (kind.kind === 'dev') { devEdges.push(edge); continue; }
        if (target.source === null && !metadata.workspace_members.includes(dep.pkg)) fail(`Unowned Cargo path dependency ${target.name}`);
        if (![null, 'build'].includes(kind.kind)) fail(`Unknown Cargo dependency kind ${kind.kind}`);
        assertEdge(component, target.name, components, `Cargo ${edge.kind}`);
        edges.push(edge);
      }
    }
  }
  for (const component of policy.components.filter(c => c.ecosystem === 'cargo')) {
    if (!metadata.workspace_members.some(id => packages.get(id)?.name === component.name)) fail(`Missing Cargo owner ${component.name}`);
  }
  const closures = {};
  for (const root of policy.minimumCargoRoots) {
    const pkg = metadata.packages.find(p => p.name === root && metadata.workspace_members.includes(p.id));
    if (!pkg) fail(`Missing minimum Cargo root ${root}`);
    const seen = new Set(), todo = [pkg.id];
    while (todo.length) {
      const id = todo.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const target = packages.get(id), node = nodes.get(id);
      if (!target || !node) fail(`Incomplete Cargo closure ${id}`);
      if (target.source === null && !metadata.workspace_members.includes(id)) fail(`Unowned Cargo path dependency ${target.name}`);
      if (!components.has(target.name) && !policy.minimumCargoExternal.includes(target.name)) fail(`Unreviewed minimum Cargo dependency ${root} -> ${target.name}`);
      if (components.has(target.name) && !policy.minimumCargoRoots.includes(target.name)) fail(`Companion in minimum Cargo closure ${root} -> ${target.name}`);
      for (const dep of node.deps) if (dep.dep_kinds.some(k => k.kind !== 'dev')) todo.push(dep.pkg);
    }
    closures[root] = [...seen].map(id => ({ name: packages.get(id).name, version: packages.get(id).version, source: packages.get(id).source })).sort((a, b) => a.name.localeCompare(b.name));
  }
  return { members: metadata.workspace_members.length, edges, devEdges, closures };
}

export async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) fail(`Source symlink is outside ownership: ${entry.name}`);
    const next = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await walk(next));
    else files.push(next);
  }
  return files;
}

function literal(node) {
  while (node && ['TSAsExpression', 'ParenthesizedExpression', 'TSTypeAssertion', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(node.type)) node = node.expression;
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
}

function children(node) {
  return Object.entries(node).filter(([key]) => !['loc', 'leadingComments', 'trailingComments', 'innerComments', 'comments'].includes(key))
    .flatMap(([, value]) => Array.isArray(value) ? value.filter(child => child?.type) : value?.type ? [value] : []);
}

// The legacy fixture loader imports a const URL alias. Admit only a uniquely
// bound, unassigned local constant with a literal URL and import.meta.url base.
// Ambiguous/shadowed aliases remain unbounded; this is not general dataflow.
function urlAliases(source) {
  const bindings = new Map(), candidates = new Map(), assigned = new Set();
  const bind = node => {
    if (!node) return;
    if (node.type === 'Identifier') bindings.set(node.name, (bindings.get(node.name) ?? 0) + 1);
    else if (node.type === 'AssignmentPattern') bind(node.left);
    else if (node.type === 'RestElement') bind(node.argument);
    else if (node.type === 'ObjectPattern') for (const property of node.properties) bind(property.type === 'RestElement' ? property.argument : property.value);
    else if (node.type === 'ArrayPattern') for (const item of node.elements) bind(item);
  };
  const visit = (node, parent) => {
    if (node.type === 'VariableDeclarator') {
      bind(node.id);
      const init = node.init, call = init?.type === 'MemberExpression' && !init.computed && init.property.name === 'href' ? init.object : undefined;
      const base = call?.arguments?.[1];
      if (parent?.kind === 'const' && node.id.type === 'Identifier' && call?.type === 'NewExpression' && call.callee.name === 'URL' && call.arguments.length === 2 &&
          base?.type === 'MemberExpression' && !base.computed && base.property.name === 'url' && base.object.type === 'MetaProperty' && base.object.meta.name === 'import' && base.object.property.name === 'meta') {
        const value = literal(call.arguments[0]);
        if (value?.startsWith('.')) candidates.set(node.id.name, value);
      }
    }
    if (node.type.includes('Function') || ['ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'].includes(node.type)) {
      bind(node.id); for (const parameter of node.params ?? []) bind(parameter);
    }
    if (['ClassDeclaration', 'ClassExpression'].includes(node.type)) bind(node.id);
    if (node.type === 'CatchClause') bind(node.param);
    if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(node.type)) bind(node.local);
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      const target = node.left ?? node.argument;
      const names = n => { if (n?.type === 'Identifier') assigned.add(n.name); else if (n) for (const child of children(n)) names(child); };
      names(target);
    }
    for (const child of children(node)) visit(child, node);
  };
  visit(source);
  return new Map([...candidates].filter(([name]) => bindings.get(name) === 1 && !assigned.has(name) && !bindings.has('URL')));
}

export function imports(text, file) {
  const chunks = file.endsWith('.astro')
    ? [text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '', ...[...text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1])]
    : [text];
  const result = [];
  for (const chunk of chunks) {
    let source;
    try { source = parse(chunk, { sourceType: 'unambiguous', createImportExpressions: true, plugins: ['typescript', ...(file.endsWith('.tsx') ? ['jsx'] : [])] }); }
    catch (error) { fail(`Cannot parse import graph ${file}: ${error.message}`); }
    const aliases = urlAliases(source);
    const add = (node, kind) => {
      const specifier = literal(node) ?? (node?.type === 'Identifier' ? aliases.get(node.name) : undefined);
      if (specifier === undefined || !specifier) fail(`Unbounded ${kind} import in ${file}`);
      result.push({ specifier, kind });
    };
    const visit = node => {
      if (node.type === 'ImportDeclaration') add(node.source, node.importKind === 'type' ? 'type' : 'static');
      else if (['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) add(node.source, node.exportKind === 'type' ? 'type' : 'export');
      else if (node.type === 'TSImportEqualsDeclaration' && node.moduleReference.type === 'TSExternalModuleReference') add(node.moduleReference.expression, 'require');
      else if (node.type === 'TSImportType') add(node.argument, 'type');
      else if (node.type === 'ImportExpression') add(node.source, 'dynamic');
      else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') add(node.arguments[0], 'dynamic');
      for (const child of children(node)) visit(child);
    };
    visit(source);
  }
  return result;
}

const packageName = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
const inside = (file, path) => file === path || file.startsWith(path + sep);

export async function jsGraph(root, policy) {
  root = await realpath(root);
  validatePolicy(policy);
  const components = new Map(policy.components.map(c => [c.name, c]));
  const owners = policy.components.filter(c => c.ecosystem === 'js');
  const workspace = JSON.parse(await readFile(resolve(root, 'package.json')));
  // This workspace intentionally uses explicit paths; a new/globbed member needs a reviewed adapter.
  if (!Array.isArray(workspace.workspaces) || workspace.workspaces.some(p => /[*?]/.test(p))) fail('Unsupported JS workspace inventory');
  if (workspace.workspaces.length !== owners.length || workspace.workspaces.some(p => !owners.some(c => c.manifest === `${p}/package.json`))) fail('Unowned JS workspace member');
  const edges = [], inputs = new Set(['package.json']);
  const files = new Map();
  for (const owner of owners) {
    const manifest = JSON.parse(await readFile(resolve(root, owner.manifest)));
    inputs.add(owner.manifest);
    if (manifest.name !== owner.name) fail(`JS owner path mismatch ${owner.name}`);
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) for (const name of Object.keys(manifest[kind] ?? {})) {
      assertEdge(owner, name, components, kind);
      edges.push({ from: owner.name, to: name, kind });
    }
    const src = resolve(root, dirname(owner.manifest), 'src');
    for (const file of await walk(src)) if (/\.(?:[cm]?js|tsx?|astro)$/.test(file)) files.set(file, owner);
  }
  if (!files.size) fail('Empty JS source graph');
  for (const [file, owner] of files) {
    const path = portable(relative(root, file)); inputs.add(path);
    const manifest = JSON.parse(await readFile(resolve(root, owner.manifest)));
    for (const { specifier, kind } of imports(await readFile(file, 'utf8'), path)) {
      if (!specifier.startsWith('.')) {
        const name = packageName(specifier);
        assertEdge(owner, name, components, path);
        if (name !== owner.name && !['dependencies', 'optionalDependencies', 'peerDependencies'].some(k => Object.hasOwn(manifest[k] ?? {}, name))) fail(`Undeclared JS import ${owner.name} -> ${name} (${path})`);
        edges.push({ from: owner.name, to: name, kind, file: path, specifier });
        continue;
      }
      const target = resolve(dirname(file), specifier);
      const vendor = policy.generatedVendors?.find(v => resolve(root, v.importer) === file && v.specifier === specifier);
      if (vendor) {
        assertEdge(owner, vendor.package, components, path);
        if (manifest.devDependencies?.[vendor.package] !== vendor.version) fail(`Unpinned generated vendor ${vendor.package}`);
        const metadataPath = `node_modules/${vendor.package}/package.json`;
        const vendorManifest = JSON.parse(await readFile(resolve(root, metadataPath)));
        const bytes = await readFile(resolve(root, vendor.source));
        if (vendorManifest.name !== vendor.package || vendorManifest.version !== vendor.version || hash(bytes) !== vendor.sha256) fail(`Unverified generated vendor ${vendor.package}`);
        if (imports(bytes.toString('utf8'), vendor.source).length) fail(`Generated vendor ${vendor.package} acquired module imports; review its dependency graph`);
        for (const input of [metadataPath, vendor.source, vendor.builder]) inputs.add(input);
        edges.push({ from: owner.name, to: vendor.package, kind: 'generated-vendor', file: path, specifier, version: vendor.version, sha256: vendor.sha256, builder: vendor.builder });
        continue;
      }
      const generated = policy.generatedBindings?.find(b => resolve(root, b.importer) === file && b.specifier === specifier);
      if (generated) {
        if (!components.has(generated.producer)) fail('Unknown generated binding producer');
        assertEdge(owner, generated.producer, components, path);
        edges.push({ from: owner.name, to: generated.producer, kind: 'generated-binding', file: path, specifier });
        continue;
      }
      const candidates = [target, target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx'), target.replace(/\.mjs$/, '.mts')];
      const found = candidates.find(p => files.has(p));
      if (!found) fail(`Unresolved JS source import ${path} -> ${specifier}`);
      if (!inside(await realpath(found), resolve(root, 'packages'))) fail(`Outside workspace import ${path}`);
      if (files.get(found).name !== owner.name) fail(`Private workspace source import ${path} -> ${specifier}`);
      assertEdge(owner, files.get(found).name, components, path);
      edges.push({ from: owner.name, to: files.get(found).name, kind, file: path, target: portable(relative(root, found)) });
    }
  }
  return { members: owners.length, files: files.size, edges, inputs: [...inputs].sort() };
}

export async function checkLayers(root, policy) {
  const result = spawnSync('cargo', ['+1.97.1', 'metadata', '--locked', '--offline', '--format-version', '1'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`Cargo metadata failed: ${result.error?.message ?? result.stderr}`);
  const metadata = JSON.parse(result.stdout), cargo = cargoGraph(metadata, policy), js = await jsGraph(root, policy);
  const inputs = [...new Set(['contracts/layers.json', 'Cargo.toml', 'Cargo.lock', 'package-lock.json', ...policy.components.map(c => c.manifest), ...js.inputs])].sort();
  const hashes = {};
  for (const path of inputs) hashes[path] = hash(await readFile(resolve(root, path)));
  return { version: 1, scope: 'Workspace production normal/build Cargo edges (all resolved target predicates) and JS source/declarations; dev edges reported separately. Generated WASM source imports bind to owning Cargo graph; packed/lazy artifact qualification belongs to FIT-1.6.', cargo, js, inputs: hashes, cargoMetadataHash: hash(result.stdout) };
}
