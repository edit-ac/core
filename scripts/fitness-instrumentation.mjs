import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rawOperations } from '../benchmarks/attribution.mjs';

// Exact, fail-closed transforms of the benchmark bundle only. Production package
// code and size artifacts never acquire tracing hooks.
export function instrumentSource(kind, source) {
  const substitutions = {
    sdk: ['return action(raw);', 'return globalThis.__editacFitnessMeasure("sdk." + operation, () => action(raw));'],
    render: ['patch => this.#apply(patch)', 'patch => globalThis.__editacFitnessMeasure("render.patch", () => this.#apply(patch))'],
  };
  const [before, after] = substitutions[kind] ?? [];
  if (!before || source.split(before).length !== 2) throw Error(`Unrecognized ${kind} instrumentation boundary`);
  const instrumented = source.replace(before, after);
  return kind === 'render' ? instrumented + `\nconst resume = DOMRenderer.prototype.resume;
    DOMRenderer.prototype.resume = function(...args) {
      return globalThis.__editacFitnessMeasure('render.resume', () => resume.apply(this, args));
    };\n` : instrumented;
}

export function fitnessInstrumentation(root) {
  return { name: 'fitness-only-stages', setup(build) {
    build.onResolve({ filter: /wasm\/editac_runtime\.js$/ }, () => ({ path: resolve(root, 'target/fitness-runtime/editac_runtime.js') }));
    build.onLoad({ filter: /packages\/(core\/dist\/engine|web\/dist\/dom\/render)\.js$/ }, async ({ path }) => ({
      contents: instrumentSource(path.endsWith('/packages/core/dist/engine.js') ? 'sdk' : 'render', await readFile(path, 'utf8')), loader: 'js',
    }));
    build.onLoad({ filter: /fitness-runtime\/editac_wasm\.js$/ }, async ({ path }) => ({
      contents: await readFile(path, 'utf8') + `\nfor (const operation of ${JSON.stringify(rawOperations)}) {
        const original = Engine.prototype[operation];
        if (typeof original !== 'function') throw Error('Missing FFI stage: ' + operation);
        Engine.prototype[operation] = function(...args) {
          return globalThis.__editacFitnessMeasure('ffi.' + operation, () => original.apply(this, args));
        };
      }\n`, loader: 'js',
    }));
  } };
}
