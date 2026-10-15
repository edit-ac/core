// Actual pinned awareness oracle; no provider, socket, credentials or document edits.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import * as awareness from 'y-protocols/awareness';
import { createRequire } from 'node:module';
assert.equal(process.version, 'v24.19.0');
const require = createRequire(import.meta.url);
assert.equal(require('y-protocols/package.json').version, '1.0.7');
const input = JSON.parse(readFileSync(0, 'utf8'));
const doc = new Y.Doc();
doc.clientID = input.client;
const peer = new awareness.Awareness(doc);
try {
  awareness.applyAwarenessUpdate(peer, Uint8Array.from(input.bytes), 'prepared-native');
  const remote = [...peer.getStates()].filter(([id]) => id !== doc.clientID);
  assert.equal(remote.length, 1);
  const selection = remote[0][1].selection;
  assert.equal(selection.anchor.version, 1);
  assert.equal(selection.anchor.identity.documentId, input.documentId);
  peer.setLocalState({ selection });
  const bytes = [...awareness.encodeAwarenessUpdate(peer, [doc.clientID])];
  process.stdout.write(JSON.stringify({ bytes, protocol: 'y-protocols/1.0.7', node: process.version }));
} finally {
  peer.destroy();
  doc.destroy();
}
