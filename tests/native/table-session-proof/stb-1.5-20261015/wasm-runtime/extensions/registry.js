export class ModuleContractError extends Error {
    code;
    constructor(code) {
        super(`Module contract: ${code}`);
        this.code = code;
        this.name = 'ModuleContractError';
    }
}
const fail = (code) => { throw new ModuleContractError(code); };
const name = (s) => typeof s === 'string' && s.length <= 128 && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(s);
const field = (s) => s.length <= 64 && /^[a-z][a-zA-Z0-9]*$/.test(s) && !['constructor', 'prototype', '__proto__'].includes(s);
const bound = (n) => Number.isSafeInteger(n) && Number(n) > 0 && Number(n) <= 8192;
const record = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v, expected) => Object.keys(v).sort().join(',') === [...expected].sort().join(',');
/** Reject getters, cycles, prototypes and callbacks without invoking them. */
export function copyModuleData(value) {
    let budget = 65536;
    const ancestors = new Set();
    function copy(v, depth) {
        if (--budget < 0 || depth > 16)
            return fail('resource-limit');
        if (v === null || typeof v === 'boolean')
            return v;
        if (typeof v === 'number' && Number.isFinite(v))
            return v;
        if (typeof v === 'string') {
            budget -= v.length;
            if (budget < 0)
                return fail('resource-limit');
            return v;
        }
        if (!v || typeof v !== 'object' || ancestors.has(v))
            return fail('invalid-definition');
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null && proto !== Array.prototype)
            return fail('invalid-definition');
        ancestors.add(v);
        let result;
        if (Array.isArray(v)) {
            if (v.length > 8192)
                return fail('resource-limit');
            result = [];
            for (let i = 0; i < v.length; i++) {
                const d = Object.getOwnPropertyDescriptor(v, String(i));
                if (!d || !('value' in d))
                    return fail('invalid-definition');
                result.push(copy(d.value, depth + 1));
            }
            if (Reflect.ownKeys(v).length !== v.length + 1)
                return fail('invalid-definition');
        }
        else {
            result = Object.create(null);
            for (const k of Reflect.ownKeys(v)) {
                if (typeof k !== 'string')
                    return fail('invalid-definition');
                const d = Object.getOwnPropertyDescriptor(v, k);
                if (!d.enumerable || !('value' in d))
                    return fail('invalid-definition');
                budget -= k.length;
                result[k] = copy(d.value, depth + 1);
            }
        }
        ancestors.delete(v);
        return result;
    }
    return copy(value, 0);
}
function definition(value) {
    const v = copyModuleData(value);
    if (!record(v) || !keys(v, ['type', 'version', 'kind', 'attributes', 'content', 'fallback']) || !name(v.type) ||
        !Number.isSafeInteger(v.version) || Number(v.version) < 1 || Number(v.version) > 0xffffffff ||
        !['mark', 'inline-atom'].includes(String(v.kind)) || !record(v.attributes) || Object.keys(v.attributes).length > 32 ||
        !record(v.content) || !keys(v.content, ['type', 'maxUtf16']) || v.content.type !== 'text' || !bound(v.content.maxUtf16) ||
        !record(v.fallback) || !keys(v.fallback, ['type', 'source']) || v.fallback.type !== 'text' || v.fallback.source !== 'content')
        return fail('invalid-definition');
    for (const [k, a] of Object.entries(v.attributes)) {
        if (!field(k) || !record(a) || !keys(a, a.type === 'string' ? ['type', 'required', 'maxUtf16'] : ['type', 'required']) ||
            !['string', 'boolean', 'number'].includes(String(a.type)) || typeof a.required !== 'boolean' ||
            (a.type === 'string' && !bound(a.maxUtf16)))
            return fail('invalid-definition');
    }
    return v;
}
function freeze(value) {
    if (value && typeof value === 'object') {
        for (const v of Object.values(value))
            freeze(v);
        Object.freeze(value);
    }
    return value;
}
function canonical(value) {
    if (record(value))
        return JSON.stringify(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    return JSON.stringify(value);
}
export class ModuleRegistry {
    #definitions = new Map();
    #presentations = new Map();
    #frozen = false;
    register(value, presentation) {
        if (this.#frozen)
            return fail('frozen');
        const d = definition(value), previous = this.#definitions.get(d.type);
        if (previous)
            return fail(canonical(previous) === canonical(d) ? 'duplicate' : 'incompatible');
        if (this.#definitions.size >= 256)
            return fail('resource-limit');
        let p;
        if (presentation !== undefined) {
            const raw = copyModuleData(presentation);
            if (!record(raw) || !keys(raw, ['tag']) || !['span', 'mark', 'code'].includes(String(raw.tag)))
                return fail('invalid-definition');
            p = raw;
        }
        this.#definitions.set(d.type, freeze(d));
        if (p)
            this.#presentations.set(d.type, freeze(p));
        return this;
    }
    freeze() { this.#frozen = true; return this; }
    get frozen() { return this.#frozen; }
    get size() { return this.#definitions.size; }
    /** Missing types and future versions are opaque, even when their data shape differs. */
    resolve(key, envelope, text) {
        const d = this.#definitions.get(key.slice('module:'.length));
        if (!key.startsWith('module:') || !d || !Array.isArray(envelope) || envelope[0] !== d.version)
            return undefined;
        if (envelope.length !== 2 || !record(envelope[1]) || text.length > d.content.maxUtf16)
            return fail('invalid-content');
        const attrs = envelope[1];
        for (const k of Object.keys(attrs))
            if (!Object.hasOwn(d.attributes, k))
                return fail('invalid-content');
        for (const [k, shape] of Object.entries(d.attributes)) {
            const v = attrs[k];
            if (v === undefined) {
                if (shape.required)
                    return fail('invalid-content');
                continue;
            }
            if (typeof v !== shape.type || (typeof v === 'number' && !Number.isFinite(v)) ||
                (typeof v === 'string' && v.length > shape.maxUtf16))
                return fail('invalid-content');
        }
        const p = this.#presentations.get(d.type);
        return { definition: d, ...(p ? { presentation: p } : {}) };
    }
    validate(nodes) {
        if (!this.#frozen)
            return fail('frozen');
        for (const node of nodes)
            for (const run of node.runs)
                for (const [key, value] of Object.entries(run.attributes))
                    if (key.startsWith('module:'))
                        this.resolve(key, value, run.text);
    }
}
