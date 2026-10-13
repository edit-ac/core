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
                if (e && typeof e === "object" && "code" in e && "operation" in e && "message" in e && typeof e.code === "string" && typeof e.operation === "string" && typeof e.message === "string") {
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
function encode(value, operation) {
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
function utf8Length(text) {
    let size = 0;
    for (const char of text) {
        const code = char.codePointAt(0);
        size += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
    }
    return size;
}
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
        const entries = Array.from({ length: journal.length }, (_, i) => {
            const d = descriptors[String(i)];
            if (!d || !("value" in d))
                throw new EngineError("InvalidInput", "restore", "invalid journal entry");
            const u = envelope(d.value, ["identity", "bytes"], "restore");
            return { identity: u.identity, bytes: Array.from(bytes(u.bytes, "restore")) };
        });
        return ownHandle(construct(encode({ expected, identity: c.identity, initialized: c.initialized, writerId: c.writerId, journal: entries }, "restore"), checkpointBytes));
    });
}
function ownHandle(allocation) {
    let raw = allocation;
    let nextId = 0, dispatching = false;
    const listeners = new Map();
    const queue = [];
    const failures = [];
    const use = (operation, action) => invoke(operation, () => {
        if (!raw)
            throw new EngineError("Disposed", operation, "engine has been disposed");
        return action(raw);
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
    let fragmentPreflight;
    const clearPreflight = () => { const cached = fragmentPreflight; fragmentPreflight = undefined; if (cached)
        use('releasePlan', e => e.release_plan(cached.plan)); };
    const mutate = (operation, action, invalidates = true) => {
        if (invalidates)
            clearPreflight();
        const result = use(operation, action);
        const patch = use("patch", e => JSON.parse(e.take_patch()));
        if (patch && listeners.size)
            queue.push({ patch, listeners: [...listeners.entries()] });
        dispatch();
        return result;
    };
    const prepare = (request) => {
        const input = encode(request, 'prepare');
        if (fragmentPreflight?.input === input) {
            const plan = fragmentPreflight.plan;
            fragmentPreflight = undefined;
            return plan;
        }
        clearPreflight();
        return use('prepare', e => JSON.parse(e.prepare(input)).token);
    };
    const releasePlan = (plan) => use("releasePlan", e => e.release_plan(token(plan, "releasePlan")));
    const extensions = (options) => {
        const list = options.extensions ?? [], names = new Set();
        if (list.length > 32)
            throw new EngineError("ResourceLimit", "markdown", "too many extensions");
        for (const e of list) {
            if (!/^[a-z][a-z0-9-]{0,63}$/.test(e.name) || names.has(e.name))
                throw new EngineError("InvalidInput", "markdown", "invalid or duplicate extension name");
            names.add(e.name);
        }
        return list;
    };
    const importMarkdown = (source, options = {}) => use("importMarkdown", e => {
        const hooks = extensions(options);
        let p = JSON.parse(e.import_markdown(encode({ source, images: options.images ?? false, tables: options.tables ?? false, callouts: options.callouts ?? false }, "importMarkdown")));
        for (const extension of hooks) {
            const blocks = extension.prepare?.(JSON.parse(JSON.stringify(p)));
            if (blocks === undefined)
                continue;
            const serialized = encode(blocks, "importMarkdown");
            // Native bounded transfer admission, without any live transaction.
            e.export_markdown(serialized);
            const owned = JSON.parse(serialized);
            p = { ...p, blocks: owned, ranges: owned.map(() => [0, utf8Length(source)]) };
        }
        return p;
    });
    const exportMarkdown = (blocks, options = {}) => use("exportMarkdown", e => {
        const encoded = encode(blocks, "exportMarkdown"), fallback = JSON.parse(e.export_markdown(encoded));
        for (const extension of extensions(options)) {
            const markdown = extension.serialize?.(JSON.parse(encoded));
            if (markdown === undefined)
                continue;
            if (typeof markdown !== "string" || utf8Length(markdown) > 1048576)
                throw new EngineError("ResourceLimit", "exportMarkdown", "extension output exceeds limit");
            const parsed = importMarkdown(markdown, options);
            const lossless = JSON.parse(e.markdown_equivalent(encode([JSON.parse(encoded), parsed.blocks], "markdownEquivalent")));
            return { markdown, diagnostics: lossless ? [] : [{ code: "extension-unrepresentable", range: [0, 0] }], recovery: lossless ? [] : JSON.parse(encoded) };
        }
        return fallback;
    });
    return Object.freeze({
        read: () => use("read", e => JSON.parse(e.read())),
        importMarkdown, exportMarkdown,
        anchor: (node, offset, bias) => use("anchor", e => JSON.parse(e.anchor(encode({ node, offset, bias }, "anchor"))).token),
        exportAnchor: (anchor) => use("exportAnchor", e => JSON.parse(e.export_anchor(token(anchor, "exportAnchor")))),
        importAnchor: (anchor) => use("importAnchor", e => {
            const input = encode(anchor, "importAnchor");
            if (utf8Length(input) > 4096)
                throw new EngineError("ResourceLimit", "importAnchor", "presence anchor limit");
            return JSON.parse(e.import_anchor(input)).token;
        }),
        resolve: (anchor) => use("resolve", e => JSON.parse(e.resolve(token(anchor, "resolve")))),
        releaseAnchor: (anchor) => use("releaseAnchor", e => e.release_anchor(token(anchor, "releaseAnchor"))),
        prepare,
        can: (request) => {
            try {
                const input = encode(request, 'can');
                if (request.kind === 'fragment') {
                    if (fragmentPreflight?.input !== input) {
                        clearPreflight();
                        fragmentPreflight = { input, plan: use('can', e => JSON.parse(e.prepare(input)).token) };
                    }
                    return true;
                }
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
        history: (request) => mutate("history", e => JSON.parse(e.history(encode(request, "history"))), request.type === 'undo' || request.type === 'redo'),
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
            clearPreflight();
            const owned = raw;
            raw = undefined;
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
