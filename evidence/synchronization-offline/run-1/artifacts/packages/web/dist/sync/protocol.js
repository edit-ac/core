/** y-protocols 1.0.7 baseline messages, without a provider/room envelope. */
export const syncMessage = Object.freeze({ step1: 0, step2: 1, update: 2 });
const hardFrameLimit = 16 * 1024 * 1024;
const identityFields = ["profile", "schema", "protocolVersion", "updateEncoding", "offsets", "documentId", "epoch"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class SyncProtocolError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "SyncProtocolError";
    }
}
function fail(code, message) { throw new SyncProtocolError(code, message); }
function identity(input) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== identityFields.length
        || identityFields.some(key => !Object.getOwnPropertyDescriptor(input, key)?.value))
        fail("invalid-metadata", "Complete immutable metadata required");
    if (!uuid.test(input.documentId) || !uuid.test(input.epoch))
        fail("invalid-metadata", "Canonical document and epoch UUIDs required");
    if (typeof input.profile !== "string" || typeof input.schema !== "string" || input.protocolVersion !== 1
        || input.updateEncoding !== 1 || input.offsets !== "utf16")
        fail("unsupported-profile", "Only the pinned v1 sync/update profile is supported");
    return { ...input };
}
function match(expected, offered) {
    for (const key of identityFields)
        if (expected[key] !== offered[key]) {
            fail(key === "documentId" ? "wrong-document" : key === "epoch" ? "wrong-epoch" : "unsupported-profile", `Mismatched ${key}`);
        }
}
function writeUint(value) {
    const result = [];
    do {
        const digit = value % 128;
        value = Math.floor(value / 128);
        result.push(digit | (value ? 128 : 0));
    } while (value);
    return result;
}
/** Safe, canonical uint32 decoding; no bitwise overflow or unbounded varints. */
function readUint(bytes, cursor) {
    let result = 0;
    for (let i = 0; i < 5; i++) {
        const byte = bytes[cursor.offset++];
        if (byte === undefined)
            fail("invalid-frame", "Truncated varuint");
        result += (byte & 127) * 2 ** (7 * i);
        if (result > 0xffffffff)
            fail("invalid-frame", "Varuint overflow");
        if (byte < 128) {
            if (i && byte === 0)
                fail("invalid-frame", "Noncanonical varuint");
            return result;
        }
    }
    return fail("invalid-frame", "Varuint overflow");
}
function validateVector(bytes) {
    if (bytes.length > 64 * 1024)
        fail("resource-limit", "State vector exceeds byte limit");
    const cursor = { offset: 0 }, count = readUint(bytes, cursor), clients = new Set();
    if (count > 4096)
        fail("resource-limit", "State vector exceeds client limit");
    if (count > Math.floor((bytes.length - cursor.offset) / 2))
        fail("invalid-frame", "Truncated state vector");
    for (let i = 0; i < count; i++) {
        const client = readUint(bytes, cursor);
        readUint(bytes, cursor);
        if (clients.has(client))
            fail("invalid-frame", "Duplicate state-vector client");
        clients.add(client);
    }
    if (cursor.offset !== bytes.length)
        fail("invalid-frame", "Trailing state-vector bytes");
}
/** Internal direct adapter over the existing Rust replica. The host supplies the
 * peer's complete metadata before constructing it; authentication is host-owned.
 * No Y.Doc mirror, document initialization, history reset or durability claim.
 * Callers own transport queues, local-origin filtering and reconnect policy.
 */
export class DirectSyncAdapter {
    engine;
    identity;
    maxFrameBytes;
    constructor(engine, peerIdentity, options = {}) {
        this.engine = engine;
        const max = options.maxFrameBytes ?? hardFrameLimit;
        if (!Number.isSafeInteger(max) || max < 3 || max > hardFrameLimit)
            fail("resource-limit", "Invalid frame limit");
        this.maxFrameBytes = max;
        const local = identity(engine.read().identity);
        match(local, identity(peerIdentity));
        this.identity = Object.freeze(local);
    }
    frame(type, payload) {
        if (!(payload instanceof Uint8Array) || !payload.length)
            fail("invalid-frame", "Nonempty binary payload required");
        const header = [...writeUint(type), ...writeUint(payload.length)];
        if (header.length + payload.length > this.maxFrameBytes)
            fail("resource-limit", "Frame exceeds byte limit");
        const result = new Uint8Array(header.length + payload.length);
        result.set(header);
        result.set(payload, header.length);
        return result;
    }
    step1() {
        const vector = this.engine.stateVector();
        validateVector(vector);
        return this.frame(syncMessage.step1, vector);
    }
    /** Encode an engine-emitted local update; never re-send remote/replay patches. */
    update(update) {
        match(this.identity, identity(update.identity));
        return this.frame(syncMessage.update, update.bytes);
    }
    receive(frame) {
        if (!(frame instanceof Uint8Array) || !frame.length)
            fail("invalid-frame", "Nonempty binary frame required");
        if (frame.length > this.maxFrameBytes)
            fail("resource-limit", "Frame exceeds byte limit");
        const cursor = { offset: 0 }, type = readUint(frame, cursor);
        if (type > syncMessage.update)
            fail("invalid-frame", "Unknown baseline sync message");
        const length = readUint(frame, cursor);
        if (!length || length !== frame.length - cursor.offset)
            fail("invalid-frame", "Truncated or trailing frame bytes");
        const payload = frame.slice(cursor.offset);
        if (type === syncMessage.step1) {
            validateVector(payload);
            return { type: "step1", reply: this.frame(syncMessage.step2, this.engine.encodeUpdate(payload).bytes) };
        }
        // Rust stages bounded binary/schema admission on a disposable replica first.
        const result = this.engine.applyUpdate({ identity: { ...this.identity }, bytes: payload });
        return { type: type === syncMessage.step2 ? "step2" : "update", reply: null, revision: result.revision };
    }
}
