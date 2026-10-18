// This is a post-generation optimization for the pinned wasm-bindgen 0.2.129
// web ABI. Match complete bodies, not arbitrary JavaScript or future bindgen ABIs.
const methods = [
  ['asset_work', 'input'], ['anchor', 'input'], ['can', 'input'], ['commit', 'token'],
  ['export_anchor', 'token'], ['history', 'input'],
  ['import_anchor', 'input'],
  ['prepare', 'input'], ['resolve', 'token'],
  ['checkpoint_metadata', ''], ['read', ''], ['take_patch', ''], ['validate_fragment', 'input'],
  ['apply_update', 'input, bytes'],
];

function body(name, parameters) {
  const arity = parameters ? parameters.split(', ').length : 0;
  const result = arity + 1, deferred = arity + 2;
  const input = arity ? `            const ptr0 = passStringToWasm0(${parameters.split(', ')[0]}, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
` : '';
  const bytes = arity === 2 ? `            const ptr1 = passArray8ToWasm0(bytes, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
` : '';
  return `    ${name}(${parameters}) {
        let deferred${deferred}_0;
        let deferred${deferred}_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
${input}${bytes}            wasm.engine_${name}(retptr, this.__wbg_ptr${arity ? ', ptr0, len0' : ''}${arity === 2 ? ', ptr1, len1' : ''});
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            var ptr${result} = r0;
            var len${result} = r1;
            if (r3) {
                ptr${result} = 0; len${result} = 0;
                throw takeObject(r2);
            }
            deferred${deferred}_0 = ptr${result};
            deferred${deferred}_1 = len${result};
            return getStringFromWasm0(ptr${result}, len${result});
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred${deferred}_0, deferred${deferred}_1, 1);
        }
    }`;
}

const binaryMethods = [['checkpoint_bytes', ''], ['state_vector', ''], ['encode_update', 'vector']];
function binaryBody(name, parameters) {
  const input = parameters ? `            const ptr0 = passArray8ToWasm0(vector, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
` : '';
  return `    ${name}(${parameters}) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
${input}            wasm.engine_${name}(retptr, this.__wbg_ptr${parameters ? ', ptr0, len0' : ''});
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v${parameters ? 2 : 1} = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v${parameters ? 2 : 1};
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }`;
}
function voidBody(name) {
  return `    ${name}(token) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(token, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len0 = WASM_VECTOR_LEN;
            wasm.engine_${name}(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }`;
}

const helper = `
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
`;

export function shareEngineStringAdapters(source) {
  if (/\n    (?:import_markdown|export_markdown|markdown_equivalent)\(/.test(source)) throw new Error('Unsupported legacy engine Markdown profile');
  if (source.includes('function engineStringResult(')) throw new Error('WASM glue already optimized');
  let optimized = source;
  for (const [name, parameters] of methods) {
    const expected = body(name, parameters);
    if (optimized.split(expected).length !== 2) {
      throw new Error(`Pinned WASM glue template mismatch: Engine.${name}`);
    }
    optimized = optimized.replace(expected, `    ${name}(${parameters}) {
        return engineStringResult(wasm.engine_${name}, this.__wbg_ptr${parameters ? ', ' + parameters : ''});
    }`);
  }
  for (const [name, parameters] of binaryMethods) {
    const expected = binaryBody(name, parameters);
    if (optimized.split(expected).length !== 2) throw new Error(`Pinned WASM glue template mismatch: Engine.${name}`);
    optimized = optimized.replace(expected, `    ${name}(${parameters}) {
        return engineBytesResult(wasm.engine_${name}, this.__wbg_ptr${parameters ? ', vector' : ''});
    }`);
  }
  for (const name of ['release_anchor', 'release_plan']) {
    const expected = voidBody(name);
    if (optimized.split(expected).length !== 2) throw new Error(`Pinned WASM glue template mismatch: Engine.${name}`);
    optimized = optimized.replace(expected, `    ${name}(token) {
        return engineVoidResult(wasm.engine_${name}, this.__wbg_ptr, token);
    }`);
  }
  if (optimized.split(loadBody).length !== 2) throw new Error('Pinned WASM glue template mismatch: response loader');
  return optimized + helper + binaryHelper + runtimeHelper;
}

const binaryHelper = `
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
`;

const loadBody = "async function __wbg_load(module, imports) {\n    if (typeof Response === 'function' && module instanceof Response) {\n        if (!module.ok) {\n            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);\n        }\n\n        if (typeof WebAssembly.instantiateStreaming === 'function') {\n            try {\n                return await WebAssembly.instantiateStreaming(module, imports);\n            } catch (e) {\n                const validResponse = expectedResponseType(module.type);\n\n                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {\n                    console.warn(\"`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\\n\", e);\n\n                } else { throw e; }\n            }\n        }\n\n        const bytes = await module.arrayBuffer();\n        return await WebAssembly.instantiate(bytes, imports);\n    } else {\n        const instance = await WebAssembly.instantiate(module, imports);\n\n        if (instance instanceof WebAssembly.Instance) {\n            return { instance, module };\n        } else {\n            return instance;\n        }\n    }\n\n    function expectedResponseType(type) {\n        switch (type) {\n            case 'basic': case 'cors': case 'default': return true;\n        }\n        return false;\n    }\n}\n";
const runtimeHelper = `
// Internal string-URL SDK initializer; raw default/initSync compatibility stays intact.
export async function initRuntime(assetUrl) {
    if (wasm !== undefined) return wasm;
    const imports = __wbg_get_imports(), response = await fetch(assetUrl);
    if (!response.ok) throw new Error(\`failed to fetch Wasm: \${response.status} \${response.statusText} fetching '\${response.url}'\`);
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
`;
