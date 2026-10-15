import { readFile } from 'node:fs/promises';
// Count executed production methods; never instrument shipped package artifacts.
export function gestureInstrumentation() {
  return { name: 'gesture-only-work', setup(build) {
    build.onLoad({ filter: /packages\/web\/dist\/dom\/(render|selection)\.js$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      const renderer = path.endsWith('/render.js');
      const name = renderer ? 'DOMRenderer' : 'DOMSelection';
      const methods = renderer ? { textBlockIds: 'fullScan', positions: 'positions' } : { toModel: 'mapping' };
      return { contents: source + `\nfor (const [method, key] of Object.entries(${JSON.stringify(methods)})) {
        const original = ${name}.prototype[method];
        if (typeof original !== 'function') throw Error('Missing gesture boundary: ' + method);
        ${name}.prototype[method] = function(...args) {
          globalThis.__editacGesture?.note(key);
          const result = original.apply(this, args);
          if (method === 'positions') globalThis.__editacGesture?.note('visitedPositions', result.length);
          return result;
        };
      }\n`, loader: 'js' };
    });
  } };
}
