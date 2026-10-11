// Local construction/admission example; structural exchange is FND-1.12.
import * as Y from 'yjs';
import seed from './seed.json' with { type: 'json' };
export { seed };

export function roots(doc) {
  return Object.fromEntries(Object.keys(seed.roots).map(name => [name, doc.getMap(name)]));
}

export function constructSeed() {
  const doc = new Y.Doc();
  doc.clientID = seed.seedWriter; // Deterministic fixture only; never production reuse.
  const maps = roots(doc); // Acquire roots before the write transaction.
  doc.transact(() => {
    for (const node of seed.nodes) {
      maps['registry-parents'].set(node.id, node.kind);
      const text = new Y.XmlText();
      maps['registry-texts'].set(node.id, text);
      text.insert(0, node.text);
      text.format(node.format.offset, node.format.length, node.format.attributes);
      maps['registry-placements'].set(node.id, node.placement.slice());
    }
    maps['probe-split-join'].set('pair', seed.layout.slice());
  }, 'initialize');
  return doc;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const profileKeys = ['profile', 'schema', 'protocolVersion', 'updateEncoding', 'offsets'];
const keys = [...profileKeys, 'documentId', 'epoch'];
function valid(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && keys.every(key => Object.hasOwn(value, key))
    && ['profile', 'schema', 'offsets'].every(key => typeof value[key] === 'string')
    && Number.isInteger(value.protocolVersion) && Number.isInteger(value.updateEncoding)
    && typeof value.documentId === 'string' && uuid.test(value.documentId)
    && typeof value.epoch === 'string' && uuid.test(value.epoch);
}

// No automatic migration, writes, decode or initialization during negotiation.
export function admit(expected, offered) {
  if (!valid(expected) || !valid(offered)) return 'invalid-metadata';
  if (profileKeys.some(key => expected[key] !== seed.metadata[key]
    || offered[key] !== expected[key])) return 'unsupported-profile';
  if (offered.documentId !== expected.documentId) return 'wrong-document';
  if (offered.epoch !== expected.epoch) return 'wrong-epoch';
  return 'accepted';
}

export function applyAdmitted(doc, expected, offered, bytes, origin = 'remote') {
  const result = admit(expected, offered);
  if (result !== 'accepted') return result;
  // Trusted fixture bytes only. Production requires staged shape/resource validation.
  Y.applyUpdate(doc, bytes, origin);
  return result;
}
