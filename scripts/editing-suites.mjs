// One dispatch table for selected proof and mandatory full-group inclusion.
const semantic = [
  'tests/editing/semantic.test.mjs',
  'tests/editing/semantic-variants.test.mjs',
  'tests/editing/selection-results.test.mjs',
  'tests/editing/schema-rejection.test.mjs',
  'tests/editing/mixed-batch.test.mjs',
  'tests/editing/unicode.test.mjs',
  'tests/editing/pending.test.mjs',
  'tests/editing/storage-atomicity.test.mjs',
  'tests/editing/mixed-storage.test.mjs',
  'tests/editing/schema-storage.test.mjs',
];
const selected = {
  'regression-variants': semantic[1],
  'selection-results': semantic[2],
  'selection-actions': semantic[2],
  'schema-rejection': semantic[3],
  'mixed-batch': semantic[4],
  'unicode': semantic[5],
  'pending': semantic[6],
  'storage-atomicity': semantic[7],
  'mixed-storage': semantic[8],
  'schema-storage': semantic[9],
};
export const caseSelectors = Object.freeze(Object.keys(selected));
export function editingSuites(group, selector) {
  if (selector !== undefined) {
    if (group !== 'semantic' || !Object.hasOwn(selected, selector)) throw new Error('Unqualified editing selector');
    return [selected[selector]];
  }
  if (group === 'semantic') return [...semantic];
  if (group === 'fixtures') return ['tests/editing/fixture-loader.test.mjs'];
  throw new Error(`Editing group ${group} has no qualified runtime suite yet`);
}
