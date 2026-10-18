import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';
export const sha = value => createHash('sha256').update(value).digest('hex');
const read = path => readFileSync(path, 'utf8');
export function publicImports(source) {
  const file = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const modules = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type) && node.source) modules.push(node.source.value);
    if (node.type === 'ImportExpression') { assert.equal(node.source.type, 'StringLiteral', 'literal module only'); modules.push(node.source.value); }
    if (node.type === 'CallExpression' && (node.callee.type === 'Import' || (node.callee.type === 'Identifier' && node.callee.name === 'require'))) {
      assert.equal(node.arguments.length, 1, 'literal module only');
      assert.equal(node.arguments[0].type, 'StringLiteral', 'literal module only'); modules.push(node.arguments[0].value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(file);
  for (const name of modules) assert.ok(['@edit-ac/web', '@edit-ac/core'].includes(name) || /^\.\/[a-z-]+\.js$/.test(name), `Private/unsupported import: ${name}`);
  return modules;
}
export function validateManifest(manifest, load = read, packageVersion = name => JSON.parse(read(`packages/${name.split('/')[1]}/package.json`)).version) {
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.facadeApiVersion, 1);
  assert.deepEqual(Object.keys(manifest.packages).sort(), ['@edit-ac/core','@edit-ac/web']);
  for (const [name, version] of Object.entries(manifest.packages)) assert.equal(packageVersion(name), version, `Stale package ${name}`);
  assert.deepEqual(manifest.recipes.map(r => r.id).sort(), ['getting-started','behavior','data','lifecycle','task-links','catalog','spellcheck','parsing','url-insert'].sort());
  const guides = new Map(manifest.guides.map(g => [g.path, g]));
  for (const guide of guides.values()) assert.equal(sha(load(guide.path)), guide.sha256, `Stale guide ${guide.path}`);
  const outputs = new Set();
  return manifest.recipes.map(recipe => {
    assert.match(recipe.source, /^examples\/extensions\/[a-z-]+\/[a-z-]+\.ts$/);
    assert.ok(!outputs.has(recipe.output), 'Duplicate recipe output'); outputs.add(recipe.output);
    assert.equal(recipe.output, recipe.source.split('/').at(-1));
    const full = load(recipe.source), lines = full.split('\n'); if (lines.at(-1) === '') lines.pop();
    assert.ok(Number.isInteger(recipe.startLine) && Number.isInteger(recipe.endLine) && recipe.startLine >= 1 && recipe.endLine >= recipe.startLine && recipe.endLine <= lines.length, 'Stale source range');
    const source = lines.slice(recipe.startLine - 1, recipe.endLine).join('\n') + '\n';
    assert.equal(sha(source), recipe.sha256, `Stale source ${recipe.id}`);
    publicImports(source);
    const tree = parse(source, { sourceType: 'module', plugins: ['typescript'] });
    const names = tree.program.body.filter(n => n.type === 'ExportNamedDeclaration').flatMap(n => [
      ...(n.declaration?.id ? [n.declaration.id.name] : []),
      ...(n.declaration?.declarations ?? []).map(d => d.id.name),
      ...(n.specifiers ?? []).map(s => s.exported.name),
    ]);
    for (const name of recipe.exports.split(',')) assert.ok(names.includes(name), `Stale manifest export ${name}`);
    for (const name of publicImports(source).filter(n => n.startsWith('./'))) assert.ok(manifest.recipes.some(r => r.output === name.slice(2).replace(/\.js$/,'.ts')), 'Unpinned local recipe dependency');
    assert.ok(guides.has(recipe.guide), 'Unpinned guide');
    const guide = load(recipe.guide), expected = `<!-- recipe:${recipe.id} -->\n\x60\x60\x60ts\n${source}\x60\x60\x60\n<!-- /recipe:${recipe.id} -->`;
    assert.ok(guide.includes(expected), `Stale documented range ${recipe.id}`);
    return { ...recipe, text: source };
  });
}
