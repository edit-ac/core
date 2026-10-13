import assert from 'node:assert/strict';
import { test } from 'node:test';
import { minifyTask, taskMinifier } from '../scripts/minify-task.mjs';

test('lexical naming preserves exports, public properties and native private state', async () => {
  const source = `export class Counter {
    #value = 2;
    next(value) { this.#value += value; return { publicValue: this.#value }; }
  }
  export function exercise(input) { const counter = new Counter(); return counter.next(input); }`;
  const code = await minifyTask(source);
  const module = await import('data:text/javascript,' + encodeURIComponent(code));
  assert.deepEqual(module.exercise(3), { publicValue: 5 });
  const counter = new module.Counter();
  assert.deepEqual(counter.next(4), { publicValue: 6 });
  assert.deepEqual(counter.next(1), { publicValue: 7 });
  assert.equal(await minifyTask(source), code);
  assert.equal(taskMinifier.mangle, true);
});

test('many live lexical names remain distinct across nested scopes and reserved words', async () => {
  // Calls prevent constant folding; all bindings stay live while the name
  // generator crosses single-letter names and reserved two-letter words.
  const declarations = Array.from({ length: 140 }, (_, i) => `const local${i} = source(${i});`).join('\n');
  const values = Array.from({ length: 140 }, (_, i) => `local${i}`).join(',');
  const source = `export function read(source) { ${declarations}
    return function nested(source) { return [source, ${values}]; }; }`;
  const code = await minifyTask(source);
  const module = await import('data:text/javascript,' + encodeURIComponent(code));
  const retained = module.read(value => value * 3);
  assert.deepEqual(retained('outer'), ['outer', ...Array.from({ length: 140 }, (_, i) => i * 3)]);
});
