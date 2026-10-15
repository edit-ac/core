export const EXTENSION_TRANSFER_VERSION = 1;
export const EXTENSION_TRANSFER_MIME = 'application/x-edit-ac-extension+json';
const LIMIT = 1_048_576;
export class ExtensionTransferError extends Error {
    code;
    constructor(code) {
        super(`Extension transfer: ${code}`);
        this.code = code;
        this.name = 'ExtensionTransferError';
    }
}
/** Bounded copy rejects executable values/accessors before reading them. */
function inert(value) {
    let cells = 0, bytes = 0;
    const ancestors = new Set();
    const fail = (code) => { throw new ExtensionTransferError(code); };
    function copy(v, depth) {
        if (++cells > 65536 || depth > 16)
            return fail('resource-limit');
        if (v === null || typeof v === 'boolean')
            return v;
        if (typeof v === 'number' && Number.isFinite(v))
            return v;
        if (typeof v === 'string') {
            bytes += new TextEncoder().encode(v).length;
            if (bytes > LIMIT)
                return fail('resource-limit');
            return v;
        }
        if (!v || typeof v !== 'object' || ancestors.has(v))
            return fail('invalid-data');
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null && proto !== Array.prototype)
            return fail('invalid-data');
        ancestors.add(v);
        const array = Array.isArray(v), out = array ? [] : Object.create(null);
        const names = Reflect.ownKeys(v).filter(k => !(array && k === 'length'));
        if (array && (names.length !== v.length || names.some((k, i) => k !== String(i))))
            return fail('invalid-data');
        for (const k of names) {
            if (typeof k !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(k))
                return fail('invalid-data');
            bytes += new TextEncoder().encode(k).length;
            if (bytes > LIMIT)
                return fail('resource-limit');
            const d = Object.getOwnPropertyDescriptor(v, k);
            if (!d || !d.enumerable || !('value' in d))
                return fail('invalid-data');
            if (Array.isArray(out))
                out.push(copy(d.value, depth + 1));
            else
                out[k] = copy(d.value, depth + 1);
        }
        ancestors.delete(v);
        Object.freeze(out);
        return out;
    }
    const out = copy(value, 0);
    if (new TextEncoder().encode(JSON.stringify(out)).length > LIMIT)
        return fail('resource-limit');
    return out;
}
const name = (v) => typeof v === 'string' && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(v) && v.length <= 128;
const version = (v) => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 0xffffffff;
const keys = (v, expected) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === expected.sort().join(',');
function envelope(value) {
    const e = inert(value);
    if (!e || typeof e !== 'object' || !keys(e, ['version', 'type', 'dataVersion', 'source', 'payload']) || e.version !== 1 || !name(e.type) || !version(e.dataVersion) || typeof e.source !== 'string')
        throw new ExtensionTransferError('invalid-data');
    return e;
}
export function exportExtensionTransfer(value) { return JSON.stringify(envelope(value)); }
export function importExtensionTransfer(raw) {
    if (typeof raw !== 'string')
        throw new ExtensionTransferError('invalid-data');
    if (new TextEncoder().encode(raw).length > LIMIT)
        throw new ExtensionTransferError('resource-limit');
    try {
        return envelope(JSON.parse(raw));
    }
    catch (error) {
        if (error instanceof ExtensionTransferError)
            throw error;
        throw new ExtensionTransferError('invalid-data');
    }
}
function choices(value, admitted) {
    return Array.isArray(value) && value.length <= admitted.length && new Set(value).size === value.length && value.every(v => admitted.includes(v));
}
const targets = new WeakMap();
export class ExtensionTransferRegistry {
    #entries = new Map();
    /** Validate the whole set before activation; caller declarations remain mutable. */
    constructor(entries) {
        if (!Array.isArray(entries) || entries.length > 64)
            throw new ExtensionTransferError('resource-limit');
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object')
                throw new ExtensionTransferError('invalid-descriptor');
            const d = inert(entry.descriptor);
            const codec = entry.codec, prepare = codec?.prepare;
            if (!keys(d, ['type', 'versions', 'inline', 'blocks', 'tableMetadata', 'fallback']) || !name(d.type) || !Array.isArray(d.versions) || !d.versions.length || d.versions.length > 32 || d.versions.some((v) => !version(v)) || new Set(d.versions).size !== d.versions.length ||
                !choices(d.inline, ['bold', 'italic', 'underline', 'strike', 'code', 'link']) || !choices(d.blocks, ['paragraph', 'heading', 'code', 'content']) || !choices(d.tableMetadata, ['rows', 'columns', 'alignment', 'header', 'spans', 'cell-paragraph-style']) || d.fallback !== 'inert-source-with-recovery' || (codec && typeof prepare !== 'function'))
                throw new ExtensionTransferError('invalid-descriptor');
            if (this.#entries.has(d.type))
                throw new ExtensionTransferError('duplicate');
            // Capture the callback once; replacement of the caller's codec cannot alter admission.
            this.#entries.set(d.type, { descriptor: d, ...(codec ? { codec: { prepare: prepare.bind(codec) } } : {}) });
        }
    }
    descriptors() { return Object.freeze([...this.#entries.values()].map(e => e.descriptor)); }
    prepare(engine, input, literal = false) {
        const e = envelope(input), snapshot = engine.read(), entry = this.#entries.get(e.type);
        const diagnostics = [];
        let mode = literal ? 'literal' : 'formatted';
        let blocks;
        if (literal || !entry?.codec || !entry.descriptor.versions.includes(e.dataVersion)) {
            if (!literal) {
                mode = 'fallback';
                diagnostics.push(!entry ? 'unknown-extension' : !entry.descriptor.versions.includes(e.dataVersion) ? 'unsupported-version' : 'unavailable-codec');
            }
            // Preserve exact bounded source and the entire typed envelope. No interpretation.
            blocks = [{ attributes: literal ? null : { type: 'content', tuple: ['module:editac.inert-extension', 1, { ...e }] }, runs: [{ text: e.source, marks: [] }] }];
        }
        else {
            try {
                blocks = inert(entry.codec.prepare(e));
            }
            catch (error) {
                if (error instanceof ExtensionTransferError)
                    throw error;
                throw new ExtensionTransferError('codec-failed');
            }
            if (!Array.isArray(blocks) || !blocks.length)
                throw new ExtensionTransferError('invalid-data');
            for (const block of blocks) {
                if (!block || typeof block !== 'object' || !Array.isArray(block.runs) || block.runs.some((r) => !r || typeof r !== 'object' || !Array.isArray(r.marks) || r.marks.some((m) => !m || typeof m !== 'object')))
                    throw new ExtensionTransferError('invalid-data');
                const type = block.attributes?.type ?? 'paragraph';
                const tuple = block.attributes?.type === 'content' ? block.attributes.tuple : null;
                if (Array.isArray(tuple) && tuple[0] === 'module:editac.table') {
                    const data = tuple[2];
                    if (!data || typeof data !== 'object' || !keys(data, ['alignments', 'rows', 'source']) ||
                        !['rows', 'columns', 'alignment', 'header'].every(k => entry.descriptor.tableMetadata.includes(k)))
                        throw new ExtensionTransferError('undeclared-formatting');
                    const rich = tuple[1] === 2;
                    if (rich && !['spans', 'cell-paragraph-style'].every(k => entry.descriptor.tableMetadata.includes(k)))
                        throw new ExtensionTransferError('undeclared-formatting');
                    if (Array.isArray(data.rows))
                        for (const row of data.rows) {
                            if (!Array.isArray(row))
                                throw new ExtensionTransferError('invalid-data');
                            for (const cell of row) {
                                if (rich && cell === null)
                                    continue;
                                let cells;
                                if (rich) {
                                    if (!cell || typeof cell !== 'object' || Array.isArray(cell) || !keys(cell, ['paragraphs', 'rowSpan', 'columnSpan', 'header']) || !Array.isArray(cell.paragraphs))
                                        throw new ExtensionTransferError('invalid-data');
                                    cells = [];
                                    for (const paragraph of cell.paragraphs) {
                                        if (!paragraph || typeof paragraph !== 'object' || Array.isArray(paragraph) || !keys(paragraph, ['style', 'runs']) || !Array.isArray(paragraph.style) || !Array.isArray(paragraph.runs))
                                            throw new ExtensionTransferError('invalid-data');
                                        if (!entry.descriptor.blocks.includes(paragraph.style[0]))
                                            throw new ExtensionTransferError('undeclared-formatting');
                                        cells.push(...paragraph.runs);
                                    }
                                }
                                else {
                                    if (!Array.isArray(cell))
                                        throw new ExtensionTransferError('invalid-data');
                                    cells = cell;
                                }
                                for (const run of cells) {
                                    const marks = Array.isArray(run) ? run[1] : null;
                                    if (!Array.isArray(marks) || marks.some(m => !Array.isArray(m) || !entry.descriptor.inline.includes(m[0])))
                                        throw new ExtensionTransferError('undeclared-formatting');
                                }
                            }
                        }
                }
                if (!entry.descriptor.blocks.includes(type) || !Array.isArray(block.runs) || block.runs.some((r) => !Array.isArray(r.marks) || r.marks.some((m) => !entry.descriptor.inline.includes(m.mark))))
                    throw new ExtensionTransferError('undeclared-formatting');
            }
        }
        // Clipboard validation requires a concrete portable style; null on the actual
        // prepared literal request retains the destination's existing formatting.
        blocks = inert(blocks);
        engine.validateFragment(JSON.stringify({ version: 1, schema: snapshot.identity.schema, blocks: blocks.map(b => ({ ...b, attributes: b.attributes ?? { type: 'paragraph' } })) }));
        if (engine.read().revision !== snapshot.revision)
            throw new ExtensionTransferError('stale-target');
        const prepared = inert({ version: 1, identity: snapshot.identity, revision: snapshot.revision, mode, blocks, recovery: e, diagnostics });
        targets.set(prepared, engine);
        return prepared;
    }
}
/** Shared host capability/commit boundary remains responsible for atomic admission,
 * history, storage and permission. Stable range tokens remain caller-owned. */
export function extensionTransferRequest(prepared, engine, range, origin, cut = false) {
    if (targets.get(prepared) !== engine)
        throw new ExtensionTransferError('stale-target');
    const value = prepared, current = engine.read();
    if (value.version !== 1 || JSON.stringify(value.identity) !== JSON.stringify(current.identity) || value.revision !== current.revision)
        throw new ExtensionTransferError('stale-target');
    return { kind: 'fragment', origin, range: { anchor: range.anchor, focus: range.focus }, blocks: cut ? [{ attributes: null, runs: [{ text: '', marks: [] }] }] : value.blocks };
}
