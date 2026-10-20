import { ModuleRegistry, ModuleContractError, copyModuleData } from './registry.js';
export class ModuleEvolutionError extends Error {
    code;
    constructor(code) {
        super(`Module evolution: ${code}`);
        this.code = code;
        this.name = 'ModuleEvolutionError';
    }
}
function immutable(v) {
    if (v && typeof v === 'object') {
        for (const x of Object.values(v))
            immutable(x);
        Object.freeze(v);
    }
    return v;
}
/** No document handle is accepted. Registration, preparation and callback failure
 * cannot rewrite live state. Inputs and callback results use registry data bounds;
 * the host must separately admit any candidate via the owning edit/epoch protocol. */
export function prepareModuleMigration(evolution, envelope, text, target, migrate) {
    const declaration = copyModuleData(evolution);
    if (!declaration || !Array.isArray(declaration.reads) || !Array.isArray(declaration.transitions) ||
        Object.keys(declaration).sort().join(',') !== 'reads,transitions' ||
        !declaration.reads.length || declaration.reads.length > 32 || declaration.transitions.length > 32)
        throw new ModuleEvolutionError('invalid-evolution');
    const readers = new Map();
    let type, kind;
    for (const d of declaration.reads) {
        const r = new ModuleRegistry().register(d).freeze();
        if (readers.has(d.version) || (type !== undefined && (type !== d.type || kind !== d.kind)))
            throw new ModuleEvolutionError('invalid-evolution');
        type = d.type;
        kind = d.kind;
        readers.set(d.version, r);
    }
    const edges = new Set();
    for (const edge of declaration.transitions) {
        if (!edge || Object.keys(edge).sort().join(',') !== 'from,to' || edge.from === edge.to ||
            !readers.has(edge.from) || !readers.has(edge.to) || edges.has(`${edge.from}:${edge.to}`))
            throw new ModuleEvolutionError('invalid-evolution');
        edges.add(`${edge.from}:${edge.to}`);
    }
    const source = immutable(copyModuleData(envelope));
    if (!Array.isArray(source) || source.length !== 2 || typeof source[0] !== 'number' ||
        !edges.has(`${source[0]}:${target}`))
        throw new ModuleEvolutionError('unsupported-transition');
    const key = `module:${type}`;
    if (!readers.get(source[0]).resolve(key, source, text))
        throw new ModuleEvolutionError('unsupported-transition');
    let attributes;
    try {
        attributes = copyModuleData(migrate(source[1]));
    }
    catch (error) {
        if (error instanceof ModuleContractError)
            throw error;
        throw new ModuleEvolutionError('migration-failed');
    }
    const candidate = immutable([target, attributes]);
    if (!readers.get(target).resolve(key, candidate, text))
        throw new ModuleEvolutionError('unsupported-transition');
    return immutable({ type: type, source, candidate, admission: 'host-prepared-edit-or-explicit-new-epoch' });
}
