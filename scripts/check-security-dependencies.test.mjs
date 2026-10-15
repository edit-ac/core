import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActiveTree, affectedAdvisories } from './security-dependency-contract.mjs';

test('active tree retains exact versions, proc macros and repeated nodes without inactive metadata nodes', () => {
  assert.deepEqual([...parseActiveTree('editac-security v0.0.0 (/workspace)\nsyn v2.0.119\nsyn v2.0.119 (*)\nquote v1.0.45 (proc-macro)\n')],
    ['editac-security@0.0.0', 'syn@2.0.119', 'quote@1.0.45']);
});
test('empty or malformed dependency evidence fails closed', () => {
  for (const text of ['', ' \n', 'dependency with no version', 'foo v1.0\nnoise']) assert.throws(() => parseActiveTree(text));
});
test('exact advisory queries preserve affected package identity and do not hide findings', () => {
  const queries = [{ package: { name: 'affected' }, version: '1.0' }, { package: { name: 'clear' }, version: '2.0' }];
  assert.deepEqual(affectedAdvisories({ results: [{ vulns: [{ id: 'RUSTSEC-fixture' }] }, {}] }, queries),
    [{ ...queries[0], id: 'RUSTSEC-fixture' }]);
  assert.deepEqual(affectedAdvisories({ results: [{}, { vulns: [] }] }, queries), []);
});
test('missing, incomplete, errored, paginated or malformed advisory results never qualify', () => {
  for (const body of [{}, { results: [] }, { results: [null] }, { results: [[]] },
    { results: [{ error: 'unavailable' }] }, { results: [{ next_page_token: 'more' }] },
    { results: [{ vulns: {} }] }, { results: [{ vulns: [{}] }] }, { results: [{ vulns: [null] }] }]) {
    assert.throws(() => affectedAdvisories(body, [{ package: { name: 'fixture' }, version: '1.0' }]));
  }
  assert.throws(() => affectedAdvisories({ results: [] }, []));
});
