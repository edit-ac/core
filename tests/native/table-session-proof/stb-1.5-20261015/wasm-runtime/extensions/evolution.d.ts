import { type ModuleDefinition } from './registry.js';
import type { Json } from '../engine.js';
/** Compatible readers and explicit, directed candidate-data transitions for one
 * descriptor. Host callbacks are not part of this persisted data declaration. */
export interface ModuleEvolution {
    reads: readonly ModuleDefinition[];
    transitions: readonly {
        from: number;
        to: number;
    }[];
}
export declare class ModuleEvolutionError extends Error {
    readonly code: 'invalid-evolution' | 'unsupported-transition' | 'migration-failed';
    constructor(code: 'invalid-evolution' | 'unsupported-transition' | 'migration-failed');
}
export interface PreparedModuleMigration {
    readonly type: string;
    readonly source: Json;
    readonly candidate: Json;
    /** Candidate data is not a document edit or authority to change an epoch. */
    readonly admission: 'host-prepared-edit-or-explicit-new-epoch';
}
/** No document handle is accepted. Registration, preparation and callback failure
 * cannot rewrite live state. Inputs and callback results use registry data bounds;
 * the host must separately admit any candidate via the owning edit/epoch protocol. */
export declare function prepareModuleMigration(evolution: ModuleEvolution, envelope: Json, text: string, target: number, migrate: (attributes: Readonly<Json>) => Json): PreparedModuleMigration;
