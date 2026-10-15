/* tslint:disable */
/* eslint-disable */

export class Engine {
    free(): void;
    [Symbol.dispose](): void;
    anchor(input: string): string;
    apply_update(input: string, bytes: Uint8Array): string;
    can(input: string): string;
    checkpoint_bytes(): Uint8Array;
    checkpoint_metadata(): string;
    commit(token: string): string;
    dispose(): void;
    encode_update(vector: Uint8Array): Uint8Array;
    export_anchor(token: string): string;
    history(input: string): string;
    import_anchor(input: string): string;
    constructor(input: string);
    prepare(input: string): string;
    read(): string;
    release_anchor(token: string): void;
    release_plan(token: string): void;
    resolve(token: string): string;
    /**
     * Explicit initialized restore; never imports defaults or reuses a writer.
     */
    static restore(input: string, bytes: Uint8Array): Engine;
    state_vector(): Uint8Array;
    /**
     * Pull the detached batch only after the semantic call has returned.
     */
    take_patch(): string;
    validate_fragment(input: string): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly engine_anchor: (a: number, b: number, c: number, d: number) => void;
    readonly engine_apply_update: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly engine_can: (a: number, b: number, c: number, d: number) => void;
    readonly engine_checkpoint_bytes: (a: number, b: number) => void;
    readonly engine_checkpoint_metadata: (a: number, b: number) => void;
    readonly engine_commit: (a: number, b: number, c: number, d: number) => void;
    readonly engine_dispose: (a: number) => void;
    readonly engine_encode_update: (a: number, b: number, c: number, d: number) => void;
    readonly engine_export_anchor: (a: number, b: number, c: number, d: number) => void;
    readonly engine_history: (a: number, b: number, c: number, d: number) => void;
    readonly engine_import_anchor: (a: number, b: number, c: number, d: number) => void;
    readonly engine_new: (a: number, b: number, c: number) => void;
    readonly engine_prepare: (a: number, b: number, c: number, d: number) => void;
    readonly engine_read: (a: number, b: number) => void;
    readonly engine_release_anchor: (a: number, b: number, c: number, d: number) => void;
    readonly engine_release_plan: (a: number, b: number, c: number, d: number) => void;
    readonly engine_resolve: (a: number, b: number, c: number, d: number) => void;
    readonly engine_restore: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly engine_state_vector: (a: number, b: number) => void;
    readonly engine_take_patch: (a: number, b: number) => void;
    readonly engine_validate_fragment: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
