/* @ts-self-types="./editac_wasm.d.ts" */

export class Engine {
    static __wrap(ptr) {
        const obj = Object.create(Engine.prototype);
        obj.__wbg_ptr = ptr;
        EngineFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_engine_free(ptr, 0);
    }
    /**
     * @param {string} input
     * @returns {string}
     */
    anchor(input) {
        return engineStringResult(wasm.engine_anchor, this.__wbg_ptr, input);
    }
    /**
     * @param {string} input
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    apply_update(input, bytes) {
        return engineStringResult(wasm.engine_apply_update, this.__wbg_ptr, input, bytes);
    }
    /**
     * @param {string} input
     * @returns {string}
     */
    can(input) {
        return engineStringResult(wasm.engine_can, this.__wbg_ptr, input);
    }
    /**
     * @returns {Uint8Array}
     */
    checkpoint_bytes() {
        return engineBytesResult(wasm.engine_checkpoint_bytes, this.__wbg_ptr);
    }
    /**
     * @returns {string}
     */
    checkpoint_metadata() {
        return engineStringResult(wasm.engine_checkpoint_metadata, this.__wbg_ptr);
    }
    /**
     * @param {string} token
     * @returns {string}
     */
    commit(token) {
        return engineStringResult(wasm.engine_commit, this.__wbg_ptr, token);
    }
    dispose() {
        wasm.engine_dispose(this.__wbg_ptr);
    }
    /**
     * @param {Uint8Array} vector
     * @returns {Uint8Array}
     */
    encode_update(vector) {
        return engineBytesResult(wasm.engine_encode_update, this.__wbg_ptr, vector);
    }
    /**
     * @param {string} token
     * @returns {string}
     */
    export_anchor(token) {
        return engineStringResult(wasm.engine_export_anchor, this.__wbg_ptr, token);
    }
    /**
     * @param {string} input
     * @returns {string}
     */
    history(input) {
        return engineStringResult(wasm.engine_history, this.__wbg_ptr, input);
    }
    /**
     * @param {string} input
     * @returns {string}
     */
    import_anchor(input) {
        return engineStringResult(wasm.engine_import_anchor, this.__wbg_ptr, input);
    }
    /**
     * @param {string} input
     */
    constructor(input) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(input, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.engine_new(retptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0;
            EngineFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @param {string} input
     * @returns {string}
     */
    prepare(input) {
        return engineStringResult(wasm.engine_prepare, this.__wbg_ptr, input);
    }
    /**
     * @returns {string}
     */
    read() {
        return engineStringResult(wasm.engine_read, this.__wbg_ptr);
    }
    /**
     * @param {string} token
     */
    release_anchor(token) {
        return engineVoidResult(wasm.engine_release_anchor, this.__wbg_ptr, token);
    }
    /**
     * @param {string} token
     */
    release_plan(token) {
        return engineVoidResult(wasm.engine_release_plan, this.__wbg_ptr, token);
    }
    /**
     * @param {string} token
     * @returns {string}
     */
    resolve(token) {
        return engineStringResult(wasm.engine_resolve, this.__wbg_ptr, token);
    }
    /**
     * Explicit initialized restore; never imports defaults or reuses a writer.
     * @param {string} input
     * @param {Uint8Array} bytes
     * @returns {Engine}
     */
    static restore(input, bytes) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(input, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(bytes, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.engine_restore(retptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return Engine.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint8Array}
     */
    state_vector() {
        return engineBytesResult(wasm.engine_state_vector, this.__wbg_ptr);
    }
    /**
     * Pull the detached batch only after the semantic call has returned.
     * @returns {string}
     */
    take_patch() {
        return engineStringResult(wasm.engine_take_patch, this.__wbg_ptr);
    }
    /**
     * @param {string} input
     * @returns {string}
     */
    validate_fragment(input) {
        return engineStringResult(wasm.engine_validate_fragment, this.__wbg_ptr, input);
    }
}
if (Symbol.dispose) Engine.prototype[Symbol.dispose] = Engine.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_getRandomValues_436a51d0629d84e1: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./editac_wasm_bg.js": import0,
    };
}

const EngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_engine_free(ptr, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_export(addHeapObject(e));
    }
}

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('editac_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };

// Shared retained Engine string-result marshalling; public signatures are unchanged.
function engineStringResult(method, pointer, ...args) {
    let deferred0;
    let deferred1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        if (args.length) {
            const ptr0 = passStringToWasm0(args[0], wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            if (args.length === 2) {
                const ptr1 = passArray8ToWasm0(args[1], wasm.__wbindgen_export2);
                const len1 = WASM_VECTOR_LEN;
                method(retptr, pointer, ptr0, len0, ptr1, len1);
            } else {
                method(retptr, pointer, ptr0, len0);
            }
        } else {
            method(retptr, pointer);
        }
        const r0 = getDataViewMemory0().getInt32(retptr, true);
        const r1 = getDataViewMemory0().getInt32(retptr + 4, true);
        const r2 = getDataViewMemory0().getInt32(retptr + 8, true);
        const r3 = getDataViewMemory0().getInt32(retptr + 12, true);
        if (r3) throw takeObject(r2);
        deferred0 = r0;
        deferred1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred0, deferred1, 1);
    }
}

function engineBytesResult(method, pointer, ...args) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            if (args.length) {
                const ptr0 = passArray8ToWasm0(args[0], wasm.__wbindgen_export2);
                const len0 = WASM_VECTOR_LEN;
                method(retptr, pointer, ptr0, len0);
            } else method(retptr, pointer);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
function engineVoidResult(method, pointer, token) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(token, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            method(retptr, pointer, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }

// Internal string-URL SDK initializer; raw default/initSync compatibility stays intact.
export async function initRuntime(assetUrl) {
    if (wasm !== undefined) return wasm;
    const imports = __wbg_get_imports(), response = await fetch(assetUrl);
    if (!response.ok) throw new Error(`failed to fetch Wasm: ${response.status} ${response.statusText} fetching '${response.url}'`);
    let result;
    if (typeof WebAssembly.instantiateStreaming === 'function') {
        try { result = await WebAssembly.instantiateStreaming(response, imports); }
        catch (error) {
            if (!['basic', 'cors', 'default'].includes(response.type) || response.headers.get('Content-Type') === 'application/wasm') throw error;
        }
    }
    result ??= await WebAssembly.instantiate(await response.arrayBuffer(), imports);
    return __wbg_finalize_init(result.instance, result.module);
}
