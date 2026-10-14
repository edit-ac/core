import assert from 'node:assert/strict';

// Yrs v1 state vectors encode an unordered client -> clock map. Decode without
// rounding 64-bit client IDs; changing serialization order is not state drift.
export function stateVectorEntries(bytes) {
  let offset = 0;
  const uint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      assert.ok(offset < bytes.length, 'truncated state vector');
      const byte = bytes[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('oversized state vector integer');
  };
  const count = uint();
  assert.ok(count <= BigInt(bytes.length), 'invalid state vector entry count');
  const entries = new Map();
  for (let i = 0n; i < count; i++) {
    const client = uint(), clock = uint();
    assert.ok(!entries.has(client), 'duplicate state vector client');
    entries.set(client, clock);
  }
  assert.equal(offset, bytes.length, 'trailing state vector data');
  return [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([client, clock]) => ({ client: client.toString(), clock: clock.toString() }));
}

export function assertRestoredReplica(restored, engine) {
  assert.deepEqual(restored.read().visible, engine.read().visible);
  assert.deepEqual(stateVectorEntries(restored.stateVector()), stateVectorEntries(engine.stateVector()));
}
