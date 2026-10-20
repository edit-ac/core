import { copyModuleData, ModuleRegistry } from './registry.js';
export class ProfileError extends Error {
    code;
    subject;
    constructor(code, subject) {
        super(`Extension profile ${code}: ${subject}`);
        this.code = code;
        this.subject = subject;
        this.name = 'ProfileError';
    }
}
const fail = (code, subject) => { throw new ProfileError(code, subject); };
const id = (v) => typeof v === 'string' && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(v) && v.length <= 128;
const version = (v) => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 0xffffffff;
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;
const strings = (v) => Array.isArray(v) && v.length <= 64 && v.every(text) && new Set(v).size === v.length;
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const freeze = (value) => {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
/** Pure admission: no feature imports, callbacks, document handle or migration. */
export function prepareExtensionProfile(input, catalog, environment) {
    let raw;
    try {
        raw = copyModuleData({ profile: input, catalog });
    }
    catch {
        return fail('invalid-data', 'profile/catalog');
    }
    const { profile, catalog: entries } = raw;
    if (!object(profile) || profile.apiVersion !== 1 || !id(profile.id) || !version(profile.version) ||
        !Array.isArray(profile.features) || profile.features.length > 64 || !Array.isArray(entries) || entries.length > 64)
        return fail('invalid-profile', 'profile');
    if (!text(environment.schema) || !strings([...environment.capabilities]) || !strings([...(environment.permissions ?? [])]))
        return fail('invalid-environment', 'schema/capabilities');
    const byId = new Map();
    for (const f of entries) {
        if (!object(f) || !id(f.id) || !version(f.version) || !strings(f.schemas) || !strings(f.capabilities) || !strings(f.permissions) ||
            !strings(f.conflicts) || !f.conflicts.every(id) || !Array.isArray(f.requires) || f.requires.length > 64 ||
            !f.requires.every(d => object(d) && id(d.id) && version(d.min) && version(d.max) && d.min <= d.max) ||
            new Set(f.requires.map(d => d.id)).size !== f.requires.length || !Array.isArray(f.bindings) || f.bindings.length > 64 ||
            !f.bindings.every(b => object(b) && ['command', 'keymap', 'input-rule'].includes(b.kind) && text(b.key) && text(b.command) && Number.isSafeInteger(b.priority)) ||
            !['qualified', 'contract-fixture'].includes(f.qualification) || !text(f.owner) || !object(f.ownership) ||
            f.ownership.focus !== 'host' || f.ownership.nestedControls !== 'exclude' || f.ownership.drag !== 'host-text-or-block' ||
            f.ownership.composition !== 'exclude' || f.ownership.selection !== 'prepared-result' || f.ownership.history !== 'one-intent' ||
            f.ownership.cancellation !== 'abort-and-revision' || f.ownership.teardown !== 'idempotent' || !strings(f.ownership.presenters))
            return fail('invalid-feature', String(f?.id));
        if (byId.has(f.id))
            return fail('duplicate', f.id);
        byId.set(f.id, f);
    }
    const selected = new Map();
    for (const ref of profile.features) {
        if (!object(ref) || !id(ref.id) || !version(ref.version))
            return fail('invalid-reference', 'features');
        if (selected.has(ref.id))
            return fail('duplicate', ref.id);
        const f = byId.get(ref.id);
        if (!f)
            return fail('missing-feature', ref.id);
        if (f.version !== ref.version)
            return fail('incompatible-version', ref.id);
        if (!f.schemas.includes(environment.schema))
            return fail('incompatible-schema', ref.id);
        for (const cap of f.capabilities)
            if (!environment.capabilities.includes(cap))
                return fail('missing-capability', `${ref.id}/${cap}`);
        for (const permission of f.permissions)
            if (!environment.permissions?.includes(permission))
                return fail('missing-permission', `${ref.id}/${permission}`);
        if (f.qualification === 'contract-fixture' && !environment.allowContractFixtures)
            return fail('pending-feature', `${ref.id}/${f.owner}`);
        selected.set(f.id, f);
    }
    for (const f of selected.values()) {
        for (const d of f.requires) {
            const dependency = selected.get(d.id);
            if (!dependency)
                return fail('missing-dependency', `${f.id}/${d.id}`);
            if (dependency.version < d.min || dependency.version > d.max)
                return fail('incompatible-dependency', `${f.id}/${d.id}`);
        }
        for (const other of f.conflicts)
            if (selected.has(other))
                return fail('conflict', `${f.id}/${other}`);
    }
    // Canonical topological order; cycle is an error, never import-order precedence.
    const features = [], pending = new Map(selected);
    while (pending.size) {
        const ready = [...pending.values()].filter(f => f.requires.every(d => !pending.has(d.id))).sort((a, b) => order(a.id, b.id));
        if (!ready.length)
            return fail('dependency-cycle', [...pending.keys()].sort().join(','));
        for (const f of ready) {
            features.push(f);
            pending.delete(f.id);
        }
    }
    const candidates = new Map();
    for (const f of features)
        for (const binding of f.bindings) {
            const key = `${binding.kind}:${binding.key}`, list = candidates.get(key) ?? [];
            if (list.some(c => c.feature === f.id))
                return fail('duplicate-binding', `${f.id}/${key}`);
            list.push({ feature: f.id, binding });
            candidates.set(key, list);
        }
    const diagnostics = [], bindings = [];
    for (const key of Object.keys(environment.remap ?? {}))
        if (!candidates.has(key))
            return fail('invalid-remap', key);
    for (const [key, list] of [...candidates].sort(([a], [b]) => order(a, b))) {
        list.sort((a, b) => b.binding.priority - a.binding.priority || order(a.feature, b.feature));
        const remap = environment.remap?.[key];
        const winner = remap ? list.find(c => c.feature === remap) : list[0];
        if (!winner)
            return fail('invalid-remap', key);
        if (!remap && list[1]?.binding.priority === winner.binding.priority)
            return fail('binding-conflict', key);
        if (remap)
            diagnostics.push(`remap ${key} -> ${winner.feature}`);
        else if (list.length > 1)
            diagnostics.push(`precedence ${key} -> ${winner.feature}`);
        bindings.push({ kind: winner.binding.kind, key: winner.binding.key, command: winner.binding.command, feature: winner.feature });
    }
    const registry = new ModuleRegistry();
    for (const f of features)
        if (f.definition)
            registry.register(f.definition);
    registry.freeze();
    profile.features.sort((a, b) => order(a.id, b.id));
    return Object.freeze({ profile: freeze(profile), features: freeze(features), bindings: freeze(bindings), diagnostics: freeze(diagnostics), registry });
}
/** Optional host work only. The existing command session owns all prepared edits;
 * this object holds no document, observer bus, key dispatcher or semantic store. */
export class ExtensionProfileActivation {
    prepared;
    timeoutMs;
    #controller = new AbortController();
    #resources = [];
    #diagnostics = [];
    #active = true;
    #busy = false;
    constructor(prepared, timeoutMs = 1000) {
        this.prepared = prepared;
        this.timeoutMs = timeoutMs;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
            fail('invalid-timeout', 'timeoutMs');
    }
    get active() { return this.#active; }
    get resourceCount() { return this.#resources.length; }
    takeDiagnostics() { return this.#diagnostics.splice(0); }
    #report(message) { if (this.#diagnostics.length === 64)
        this.#diagnostics.shift(); this.#diagnostics.push(message); }
    #dispose(resource) { try {
        resource.dispose();
    }
    catch {
        this.#report('dispose failed');
    } }
    /** One in-flight optional job, deadline/abort/revision checks before returning.
     * Does not preempt same-thread infinite loops; loader owns worker termination. */
    async work(run, validate, revision) {
        if (!this.active)
            return { status: 'cancelled' };
        if (this.#busy)
            return { status: 'busy' };
        this.#busy = true;
        const controller = new AbortController();
        let interruption;
        let timer;
        let abort = () => { };
        const interrupted = new Promise((_, reject) => {
            abort = () => { interruption = 'cancelled'; controller.abort(); reject(new ProfileError('cancelled', 'work')); };
            this.#controller.signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => { interruption = 'timeout'; controller.abort(); reject(new ProfileError('timeout', 'work')); }, this.timeoutMs);
        });
        try {
            const before = revision();
            const value = await Promise.race([Promise.resolve().then(() => run(controller.signal)), interrupted]);
            if (!this.active || controller.signal.aborted)
                return { status: interruption ?? 'cancelled' };
            if (revision() !== before)
                return { status: 'stale' };
            if (!validate(value)) {
                this.#report('malformed optional result');
                return { status: 'failed' };
            }
            if (!this.active || controller.signal.aborted)
                return { status: interruption ?? 'cancelled' };
            if (revision() !== before)
                return { status: 'stale' };
            return { status: 'ready', value };
        }
        catch (error) {
            const status = interruption ?? (error instanceof ProfileError && ['cancelled', 'timeout'].includes(error.code) ? error.code : 'failed');
            this.#report(`optional work ${status}`);
            return { status };
        }
        finally {
            clearTimeout(timer);
            this.#controller.signal.removeEventListener('abort', abort);
            this.#busy = false;
        }
    }
    /** All loader identities checked before invoking any callback. Disabled
     * features have no loader call/import; failed startup rolls back resources. */
    async activate(loaders) {
        if (!this.active || this.#busy || this.#resources.length)
            return false;
        for (const f of this.prepared.features)
            if (typeof loaders[f.id] !== 'function')
                return fail('missing-loader', f.id);
        for (const f of this.prepared.features) {
            let resource;
            const result = await this.work(async (signal) => {
                const loaded = await loaders[f.id](signal);
                if (signal.aborted || !this.active) {
                    if (loaded && typeof loaded.dispose === 'function')
                        this.#dispose(loaded);
                }
                else
                    resource = loaded;
                return loaded;
            }, (value) => !!value && typeof value.dispose === 'function', () => 'activation');
            if (result.status !== 'ready') {
                if (resource && typeof resource.dispose === 'function')
                    this.#dispose(resource);
                this.dispose();
                return false;
            }
            this.#resources.push(result.value);
        }
        return this.active;
    }
    dispose() {
        if (!this.#active)
            return;
        this.#active = false;
        this.#controller.abort();
        for (const resource of this.#resources.splice(0).reverse())
            this.#dispose(resource);
    }
}
const ownership = { focus: 'host', nestedControls: 'exclude', drag: 'host-text-or-block', composition: 'exclude', selection: 'prepared-result', history: 'one-intent', presenters: ['browser', 'terminal', 'swift-ios', 'kotlin-android', 'desktop'], cancellation: 'abort-and-revision', teardown: 'idempotent' };
const feature = (name, owner, capabilities, qualification = 'qualified') => ({
    id: `editac.${name}`, version: 1, schemas: ['editac.registry.editor.v5'], capabilities, permissions: [], requires: [], conflicts: [], bindings: [{ kind: 'command', key: `${name}.activate`, command: `${name}.activate`, priority: 100 }], qualification, owner, ownership,
});
/** Metadata only; no optional module import or runtime callback is evaluated. */
export const FIRST_PARTY_FEATURES = /* @__PURE__ */ (() => freeze([
    feature('slash', '07/21', ['commands']), feature('references', '07/21', ['commands', 'host-resolver']),
    feature('reorder', '07/21', ['commands']), feature('images', '07/21', ['source-fallback']),
    feature('tables', '07/21', ['commands', 'source-fallback']), feature('math', '07/21', ['source-fallback']),
    feature('search', 'desktop-search', ['commands'], 'contract-fixture'),
    feature('code', '25-rich-content', ['source-fallback'], 'contract-fixture'),
    feature('pairs', 'desktop-editing', ['commands'], 'contract-fixture'),
]))();
const profile = (name, names) => freeze({ apiVersion: 1, id: `editac.${name}`, version: 1, features: names.map(n => ({ id: `editac.${n}`, version: 1 })) });
export const FIRST_PARTY_PROFILES = /* @__PURE__ */ (() => freeze({
    core: profile('core', []),
    'document-tools': profile('document-tools', ['slash', 'references', 'reorder', 'images', 'tables', 'search']),
    'code-tools': profile('code-tools', ['slash', 'math', 'code', 'pairs']),
}))();
