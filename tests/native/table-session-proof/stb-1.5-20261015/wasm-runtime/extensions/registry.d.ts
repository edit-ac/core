import type { Json, ProjectedNode } from '../engine.js';
/** Portable data, separate from host rendering. Inline atoms retain label text in
 * the existing rich-text profile; no embeds or executable values enter documents. */
export interface ModuleDefinition {
    type: string;
    version: number;
    kind: 'mark' | 'inline-atom';
    attributes: Record<string, {
        type: 'string' | 'boolean' | 'number';
        required: boolean;
        maxUtf16?: number;
    }>;
    content: {
        type: 'text';
        maxUtf16: number;
    };
    fallback: {
        type: 'text';
        source: 'content';
    };
}
export interface ModulePresentation {
    tag: 'span' | 'mark' | 'code';
}
export declare class ModuleContractError extends Error {
    readonly code: 'invalid-definition' | 'duplicate' | 'incompatible' | 'frozen' | 'invalid-content' | 'resource-limit';
    constructor(code: 'invalid-definition' | 'duplicate' | 'incompatible' | 'frozen' | 'invalid-content' | 'resource-limit');
}
/** Reject getters, cycles, prototypes and callbacks without invoking them. */
export declare function copyModuleData(value: unknown): Json;
export declare class ModuleRegistry {
    #private;
    register(value: ModuleDefinition, presentation?: ModulePresentation): this;
    freeze(): this;
    get frozen(): boolean;
    get size(): number;
    /** Missing types and future versions are opaque, even when their data shape differs. */
    resolve(key: string, envelope: Json, text: string): {
        definition: Readonly<ModuleDefinition>;
        presentation?: Readonly<ModulePresentation>;
    } | undefined;
    validate(nodes: readonly ProjectedNode[]): void;
}
