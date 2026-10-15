import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { sha256, validateProfile } from '../../../scripts/capability-contract.mjs';

const core = fileURLToPath(new URL('../../../', import.meta.url));
const profile = JSON.parse(readFileSync(new URL('../capability.json', import.meta.url)));

test('bootstrap capability manifest uses the shared schema with no qualified delivery claims', () => {
  validateProfile(profile);
  assert.equal(profile.platform, 'desktop');
  assert.equal(profile.id, 'native.macos.pending.v1');
  assert.equal(profile.resources.qualified, false);
  assert.deepEqual(profile.evidence, []);
  for (const capability of profile.capabilities) {
    assert.deepEqual(capability.state, {
      available: false, enabled: false, authorized: null, qualified: false,
    });
  }
  for (const required of ['editor.read', 'editor.write', 'selection.navigate', 'clipboard.rich',
                          'editor.import', 'editor.export', 'accessibility.text',
                          'math.preserve-source', 'math.edit-source', 'math.typeset-render']) {
    assert(profile.capabilities.some(c => c.id === required), `missing capability: ${required}`);
  }
});

test('bootstrap capability inputs match actual contract, schema and pinned tooling bytes', () => {
  for (const input of profile.inputs) {
    assert.equal(sha256(readFileSync(resolve(core, input.path))), input.sha256, input.path);
  }
});
