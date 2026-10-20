import { ModuleRegistry, type ModuleDefinition } from './registry.js';
export interface ProfileFeature {
    id: string;
    version: number;
    schemas: string[];
    capabilities: string[];
    permissions: string[];
    requires: {
        id: string;
        min: number;
        max: number;
    }[];
    conflicts: string[];
    bindings: {
        kind: 'command' | 'keymap' | 'input-rule';
        key: string;
        command: string;
        priority: number;
    }[];
    definition?: ModuleDefinition;
    qualification: 'qualified' | 'contract-fixture';
    owner: string;
    ownership: {
        focus: 'host';
        nestedControls: 'exclude';
        drag: 'host-text-or-block';
        composition: 'exclude';
        selection: 'prepared-result';
        history: 'one-intent';
        presenters: string[];
        cancellation: 'abort-and-revision';
        teardown: 'idempotent';
    };
}
export interface ExtensionProfile {
    apiVersion: 1;
    id: string;
    version: number;
    features: {
        id: string;
        version: number;
    }[];
}
export interface ProfileEnvironment {
    schema: string;
    capabilities: readonly string[];
    permissions?: readonly string[];
    /** Only prepared conformance hosts may activate pending-feature fixtures. */
    allowContractFixtures?: boolean;
    /** Exact binding -> selected feature; diagnostic records every explicit remap. */
    remap?: Readonly<Record<string, string>>;
}
export interface PreparedProfile {
    readonly profile: Readonly<ExtensionProfile>;
    readonly features: readonly Readonly<ProfileFeature>[];
    readonly bindings: readonly {
        kind: string;
        key: string;
        command: string;
        feature: string;
    }[];
    readonly diagnostics: readonly string[];
    /** A fresh frozen data registry; disabling never changes the attached registry. */
    readonly registry: ModuleRegistry;
}
export declare class ProfileError extends Error {
    readonly code: string;
    readonly subject: string;
    constructor(code: string, subject: string);
}
/** Pure admission: no feature imports, callbacks, document handle or migration. */
export declare function prepareExtensionProfile(input: ExtensionProfile, catalog: readonly ProfileFeature[], environment: ProfileEnvironment): PreparedProfile;
export interface ProfileResource {
    dispose(): void;
}
export type ProfileLoader = (signal: AbortSignal) => ProfileResource | Promise<ProfileResource>;
/** Optional host work only. The existing command session owns all prepared edits;
 * this object holds no document, observer bus, key dispatcher or semantic store. */
export declare class ExtensionProfileActivation {
    #private;
    readonly prepared: PreparedProfile;
    readonly timeoutMs: number;
    constructor(prepared: PreparedProfile, timeoutMs?: number);
    get active(): boolean;
    get resourceCount(): number;
    takeDiagnostics(): string[];
    /** One in-flight optional job, deadline/abort/revision checks before returning.
     * Does not preempt same-thread infinite loops; loader owns worker termination. */
    work<T>(run: (signal: AbortSignal) => T | Promise<T>, validate: (value: unknown) => value is T, revision: () => string): Promise<{
        status: 'ready';
        value: T;
    } | {
        status: 'failed' | 'busy' | 'cancelled' | 'stale' | 'timeout';
    }>;
    /** All loader identities checked before invoking any callback. Disabled
     * features have no loader call/import; failed startup rolls back resources. */
    activate(loaders: Readonly<Record<string, ProfileLoader>>): Promise<boolean>;
    dispose(): void;
}
/** Metadata only; no optional module import or runtime callback is evaluated. */
export declare const FIRST_PARTY_FEATURES: readonly Readonly<ProfileFeature>[];
export declare const FIRST_PARTY_PROFILES: {
    core: ExtensionProfile;
    'document-tools': ExtensionProfile;
    'code-tools': ExtensionProfile;
};
