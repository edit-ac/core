export class EngineError extends Error {
    code;
    operation;
    constructor(code, operation, message) {
        super(message);
        this.code = code;
        this.operation = operation;
        this.name = "EngineError";
    }
}
function invoke(operation, action) {
    try {
        return action();
    }
    catch (error) {
        if (error instanceof EngineError)
            throw error;
        if (typeof error === "string") {
            try {
                const e = JSON.parse(error);
                if (e && typeof e === "object" && typeof e.code === "string" && typeof e.operation === "string" && typeof e.message === "string") {
                    throw new EngineError(e.code, e.operation, e.message);
                }
            }
            catch (parsed) {
                if (parsed instanceof EngineError)
                    throw parsed;
            }
        }
        throw new EngineError("InvalidInput", operation, error instanceof Error ? error.message : String(error));
    }
}
/** Avoid JSON.stringify's coercion of NaN, bigint, undefined, custom toJSON and sparse arrays. */
function encode(value, operation, ownedByteArrays) {
    let count = 0;
    const seen = new Set();
    const visit = (v, depth) => {
        if (++count > 100_000 || depth > 32)
            throw new EngineError("ResourceLimit", operation, "request exceeds structure limit");
        if (v === null || typeof v === "string" || typeof v === "boolean")
            return;
        if (typeof v === "number" && Number.isSafeInteger(v))
            return;
        if (typeof v !== "object" || seen.has(v))
            throw new EngineError("InvalidInput", operation, "request must contain plain JSON values");
        const proto = Object.getPrototypeOf(v);
        if ((Array.isArray(v) && proto !== Array.prototype) || (!Array.isArray(v) && proto !== Object.prototype && proto !== null))
            throw new EngineError("InvalidInput", operation, "request must contain plain objects");
        // Replay bytes are copied and bounded before conversion. Their numeric
        // elements are payload, not caller-supplied JSON metadata structure.
        if (Array.isArray(v) && ownedByteArrays?.has(v))
            return;
        seen.add(v);
        if (Array.isArray(v)) {
            if (v.length > 100_000 || Object.keys(v).length !== v.length)
                throw new EngineError("InvalidInput", operation, "sparse or decorated array");
            for (let i = 0; i < v.length; i++) {
                const d = Object.getOwnPropertyDescriptor(v, String(i));
                if (!d || !("value" in d))
                    throw new EngineError("InvalidInput", operation, "accessor input");
                visit(d.value, depth + 1);
            }
        }
        else {
            for (const key of Reflect.ownKeys(v)) {
                const d = Object.getOwnPropertyDescriptor(v, key);
                if (typeof key !== "string" || !("value" in d) || !d.enumerable)
                    throw new EngineError("InvalidInput", operation, "accessor or hidden input");
                visit(d.value, depth + 1);
            }
        }
        seen.delete(v);
    };
    visit(value, 0);
    return JSON.stringify(value);
}
function utf8Length(text) { return new TextEncoder().encode(text).length; }
function token(value, operation) {
    if (typeof value !== "string" || value.length > 128)
        throw new EngineError("InvalidInput", operation, "invalid opaque token");
    return value;
}
const MAX_BYTES = 16 * 1024 * 1024;
function bytes(value, operation) {
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype)
        throw new EngineError("InvalidInput", operation, "expected Uint8Array");
    const size = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength").get.call(value);
    if (size > MAX_BYTES)
        throw new EngineError("ResourceLimit", operation, "byte limit exceeded");
    const owned = new Uint8Array(size);
    Uint8Array.prototype.set.call(owned, value);
    return owned;
}
function envelope(value, keys, operation) {
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
        throw new EngineError("InvalidInput", operation, "expected plain envelope");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== keys.length || keys.some(k => !descriptors[k] || !("value" in descriptors[k]) || !descriptors[k].enumerable))
        throw new EngineError("InvalidInput", operation, "invalid envelope fields");
    return Object.fromEntries(keys.map(k => [k, descriptors[k].value]));
}
export function createHandle(construct, options) {
    return ownHandle(invoke("create", () => construct(encode(options, "create"))));
}
export function restoreHandle(construct, expected, checkpoint, journal = []) {
    return invoke("restore", () => {
        const c = envelope(checkpoint, ["identity", "initialized", "writerId", "bytes"], "restore");
        const checkpointBytes = bytes(c.bytes, "restore");
        if (!Array.isArray(journal) || Object.getPrototypeOf(journal) !== Array.prototype || Reflect.ownKeys(journal).length !== journal.length + 1 || journal.length > 4096)
            throw new EngineError("ResourceLimit", "restore", "invalid journal bounds");
        // Inspect descriptors before reading any journal element.
        const descriptors = Object.getOwnPropertyDescriptors(journal);
        const ownedByteArrays = new WeakSet();
        let journalBytes = 0;
        const entries = Array.from({ length: journal.length }, (_, i) => {
            const d = descriptors[String(i)];
            if (!d || !("value" in d))
                throw new EngineError("InvalidInput", "restore", "invalid journal entry");
            const u = envelope(d.value, ["identity", "bytes"], "restore");
            const copied = bytes(u.bytes, "restore");
            journalBytes += copied.byteLength;
            // The existing Rust request boundary is 2 MiB. Raw payload alone above
            // it cannot fit its JSON envelope; reject before expanding byte arrays.
            if (journalBytes > 2 * 1024 * 1024)
                throw new EngineError("ResourceLimit", "restore", "journal exceeds request byte limit");
            const payload = Array.from(copied);
            ownedByteArrays.add(payload);
            return { identity: u.identity, bytes: payload };
        });
        return ownHandle(construct(encode({ expected, identity: c.identity, initialized: c.initialized, writerId: c.writerId, journal: entries }, "restore", ownedByteArrays), checkpointBytes));
    });
}
function ownHandle(allocation) {
    let raw = allocation;
    let markdown;
    let nextId = 0, dispatching = false;
    const listeners = new Map();
    const queue = [];
    const failures = [];
    const use = (operation, action) => invoke(operation, () => {
        if (!raw)
            throw new EngineError("Disposed", operation, "engine has been disposed");
        return action(raw);
    });
    // Share JSON marshalling only; each public operation keeps its own diagnostic
    // name and validates inside the live-handle guard before entering WASM.
    const query = (operation, method, value, opaque = false) => use(operation, e => {
        const result = JSON.parse(e[method](opaque ? token(value, operation) : encode(value, operation)));
        return (method === "anchor" ? result.token : result);
    });
    const matches = (scope, p) => {
        switch (scope.type) {
            case "all": return true;
            case "updates": return p.update !== null;
            case "selection": return p.selectionChanged;
            case "nodes": return scope.ids.some(id => p.changedNodes.includes(id));
            case "sources": return scope.ids.some(id => p.changedSources.includes(id));
        }
    };
    const dispatch = () => {
        if (dispatching)
            return;
        dispatching = true;
        try {
            while (raw && queue.length) {
                const frame = queue.shift();
                for (const [id, listener] of frame.listeners) {
                    if (!raw || listeners.get(id) !== listener || !matches(listener.scope, frame.patch))
                        continue;
                    try {
                        // Each observer owns its detached projection/envelope and byte buffer.
                        const clone = JSON.parse(JSON.stringify(frame.patch));
                        listener.callback({ ...clone, update: clone.update ? { identity: clone.update.identity, bytes: Uint8Array.from(clone.update.bytes) } : null });
                    }
                    catch (error) {
                        if (failures.length === 64)
                            failures.shift();
                        // String conversion of a hostile thrown value must not escape dispatch.
                        let message = "observer threw";
                        try {
                            message = error instanceof Error ? error.message : String(error);
                        }
                        catch { }
                        failures.push({ subscriptionId: id, message });
                    }
                }
            }
        }
        finally {
            dispatching = false;
        }
    };
    const mutate = (operation, action) => {
        const result = use(operation, action);
        const patch = use("patch", e => JSON.parse(e.take_patch()));
        if (patch && listeners.size)
            queue.push({ patch, listeners: [...listeners.entries()] });
        dispatch();
        return result;
    };
    const prepare = (request) => {
        const input = encode(request, 'prepare');
        return use('prepare', e => JSON.parse(e.prepare(input)).token);
    };
    const releasePlan = (plan) => use("releasePlan", e => e.release_plan(token(plan, "releasePlan")));
    const codec = (operation) => {
        if (!markdown)
            throw new EngineError("CapabilityUnavailable", operation, "markdown-codec-unavailable");
        return markdown;
    };
    const importMarkdown = (source, options = {}) => use("importMarkdown", () => codec("importMarkdown").importMarkdown(source, options));
    const exportMarkdown = (blocks, options = {}) => use("exportMarkdown", () => codec("exportMarkdown").exportMarkdown(blocks, options));
    return Object.freeze({
        read: () => use("read", e => JSON.parse(e.read())),
        validateFragment: (input) => use("validateFragment", e => {
            if (typeof input !== "string")
                throw new EngineError("InvalidInput", "validateFragment", "expected fragment JSON");
            if (utf8Length(input) > 1048576)
                throw new EngineError("ResourceLimit", "validateFragment", "fragment-limit");
            e.validate_fragment(input);
        }),
        importMarkdown, exportMarkdown,
        get markdownAvailable() { return !!raw && !!markdown; },
        registerMarkdown: (candidate) => use("registerMarkdown", () => {
            if (!candidate || typeof candidate.importMarkdown !== "function" || typeof candidate.exportMarkdown !== "function")
                throw new EngineError("InvalidInput", "registerMarkdown", "invalid Markdown codec");
            if (markdown)
                throw new EngineError("InvalidInput", "registerMarkdown", "Markdown already registered");
            markdown = candidate;
            let active = true;
            return Object.freeze({ get active() { return active && !!raw && markdown === candidate; }, dispose() { if (active && markdown === candidate)
                    markdown = undefined; active = false; } });
        }),
        anchor: (node, offset, bias) => query("anchor", "anchor", { node, offset, bias }),
        exportAnchor: (anchor) => query("exportAnchor", "export_anchor", anchor, true),
        importAnchor: (anchor) => use("importAnchor", e => {
            const input = encode(anchor, "importAnchor");
            if (utf8Length(input) > 4096)
                throw new EngineError("ResourceLimit", "importAnchor", "presence anchor limit");
            return JSON.parse(e.import_anchor(input)).token;
        }),
        resolve: (anchor) => query("resolve", "resolve", anchor, true),
        releaseAnchor: (anchor) => use("releaseAnchor", e => e.release_anchor(token(anchor, "releaseAnchor"))),
        prepare,
        can: (request) => {
            try {
                const input = encode(request, 'can');
                return use('can', e => JSON.parse(e.can(input)));
            }
            catch (e) {
                if (e instanceof EngineError && ["EngineRejected", "InvalidInput", "InvalidHandle", "ResourceLimit"].includes(e.code))
                    return false;
                throw e;
            }
        },
        commit: (plan) => mutate("commit", e => JSON.parse(e.commit(token(plan, "commit")))),
        releasePlan,
        history: (request) => mutate("history", e => JSON.parse(e.history(encode(request, "history")))),
        checkpoint: () => use("checkpoint", e => ({ ...JSON.parse(e.checkpoint_metadata()), bytes: bytes(e.checkpoint_bytes(), "checkpoint") })),
        stateVector: () => use("stateVector", e => bytes(e.state_vector(), "stateVector")),
        encodeUpdate: (vector = Uint8Array.of(0)) => use("encodeUpdate", e => ({ identity: JSON.parse(e.checkpoint_metadata()).identity, bytes: bytes(e.encode_update(bytes(vector, "encodeUpdate")), "encodeUpdate") })),
        applyUpdate: (update) => mutate("applyUpdate", e => {
            const u = envelope(update, ["identity", "bytes"], "applyUpdate");
            return JSON.parse(e.apply_update(encode(u.identity, "applyUpdate"), bytes(u.bytes, "applyUpdate")));
        }),
        subscribe: (scope, callback) => use("subscribe", () => {
            const detached = JSON.parse(encode(scope, "subscribe"));
            const fields = Object.keys(detached);
            if (!detached || !["all", "updates", "selection", "nodes", "sources"].includes(detached.type) || typeof callback !== "function")
                throw new EngineError("InvalidInput", "subscribe", "invalid listener");
            if (detached.type === "nodes" || detached.type === "sources") {
                if (fields.length !== 2 || !Array.isArray(detached.ids) || detached.ids.length > 4096 || detached.ids.some(id => typeof id !== "string"))
                    throw new EngineError("InvalidInput", "subscribe", "invalid scope");
            }
            else if (fields.length !== 1)
                throw new EngineError("InvalidInput", "subscribe", "invalid scope fields");
            if (listeners.size >= 1024 || nextId === Number.MAX_SAFE_INTEGER)
                throw new EngineError("ResourceLimit", "subscribe", "subscription limit");
            const id = ++nextId;
            listeners.set(id, { scope: detached, callback });
            return Object.freeze({ get active() { return !!raw && listeners.has(id); }, dispose() { listeners.delete(id); } });
        }),
        takeObserverErrors: () => use("takeObserverErrors", () => failures.splice(0)),
        dispose: () => { if (raw) {
            const owned = raw;
            raw = undefined;
            markdown = undefined;
            listeners.clear();
            queue.length = 0;
            failures.length = 0;
            try {
                owned.dispose();
            }
            finally {
                owned.free();
            }
        } },
    });
}
