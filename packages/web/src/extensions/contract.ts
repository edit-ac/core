import { copyModuleData, prepareExtensionProfile, ProfileError } from '@edit-ac/core/extensions';
import type { ProfileFeature, ProfileEnvironment, PreparedProfile, ModuleDefinition } from '@edit-ac/core/extensions';
import type { Json, Patch, PatchSubscription, PrepareRequest, CommitResult, StableRange } from '@edit-ac/core';
import type { ModuleScope, ModuleEvent } from '../modules/runtime.js';
import type { AttachSyncOptions } from '../editor.js';

/** Admission-only API. Mount/configuration execution is delivered separately. */
export const EXTENSION_DX_VERSION = 1 as const;
export type ExtensionReadonlyV1<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer Item)[] ? readonly ExtensionReadonlyV1<Item>[] : T extends object ? { readonly [Key in keyof T]: ExtensionReadonlyV1<T[Key]> } : T;
export type ExtensionLoadPolicyV1 = 'required-input' | 'command-lazy' | 'presentation-lazy';
export type ExtensionStatusV1 =
  | { readonly state: 'unavailable' | 'idle' | 'loading' | 'ready' | 'cancelled'; readonly generation: number }
  | { readonly state: 'failed'; readonly generation: number; readonly code: string; readonly retryable: boolean };
export type ExtensionSemanticsV1 =
  | { readonly kind: 'behavior' }
  | { readonly kind: 'data'; readonly definition: ModuleDefinition };
/** Sources and UTF-16 ranges retain ModuleRuntime semantics; no new dispatcher. */
export type ExtensionInterestV1 = ModuleScope;
export interface ExtensionCallbackContextV1 {
  readonly signal: AbortSignal;
  readonly generation: number;
  /** Trusted host callbacks receive current prepared ports, never a writable replica. */
  readonly can: (request: PrepareRequest) => boolean;
  readonly commit: (request: PrepareRequest) => CommitResult;
  readonly captureCommand: (name: string, target?: StableRange) => import('../commands/catalog.js').CapturedCommand | undefined;
  readonly subscribe: (scope: ExtensionInterestV1, callback: (event: ModuleEvent) => void) => PatchSubscription;
}
export interface ExtensionAuthoringV1<Options> {
  readonly onAttach?: (options: ExtensionReadonlyV1<Options>, context: ExtensionCallbackContextV1) => void | (() => void);
  readonly onPatch?: (event: ModuleEvent, context: ExtensionCallbackContextV1) => void;
}
export interface ExtensionDefinitionV1<Options extends Record<string, Json>> {
  readonly apiVersion: 1;
  readonly feature: ProfileFeature;
  readonly semantics: ExtensionSemanticsV1;
  readonly defaults: Options;
  /** Pure host option validator; false becomes an extension/option diagnostic. */
  readonly validateOptions: (options: ExtensionReadonlyV1<Options>) => boolean;
  readonly loading: ExtensionLoadPolicyV1;
  /** Empty means no input/selection callbacks; omitted operations never mean all. */
  readonly interests: readonly ExtensionInterestV1[];
}
export interface ConfiguredExtensionV1<Options extends Record<string, Json> = Record<string, Json>> {
  readonly apiVersion: 1;
  readonly feature: ExtensionReadonlyV1<ProfileFeature>;
  readonly options: ExtensionReadonlyV1<Options>;
  readonly semantics: ExtensionReadonlyV1<ExtensionSemanticsV1>;
  readonly loading: ExtensionLoadPolicyV1;
  readonly interests: readonly ExtensionInterestV1[];
}
export interface ExtensionFactoryV1<Options extends Record<string, Json>> {
  readonly name: string;
  readonly version: number;
  configure(options?: Partial<Options>): ConfiguredExtensionV1<Options>;
}
export type CoreFormattingMarkV1 = 'bold' | 'italic' | 'strike' | 'underline' | 'code' | 'link';
export interface CoreFormattingV1 {
  /** Omitted fields retain legacy offered controls; commands false requires both UI switches false. */
  readonly marks?: Partial<Record<CoreFormattingMarkV1, { readonly commands?: boolean; readonly shortcuts?: boolean; readonly controls?: boolean }>>;
}
export interface PresenceConfigurationV1 {
  readonly awareness: boolean;
  readonly peerCarets: boolean;
}
export interface CollaborationConfigurationV1 {
  /** Only an explicit remote gate may delay ready; local is always the default. */
  readonly readiness?: 'local' | 'remote';
  readonly connect: (context: { readonly signal: AbortSignal; readonly generation: number }) => AttachSyncOptions | Promise<AttachSyncOptions>;
  readonly presence?: PresenceConfigurationV1;
}
export interface PlatformPreferencesV1 {
  readonly spellcheck?: 'platform' | 'off' | 'custom';
  readonly autocorrection?: 'inherit' | 'on' | 'off';
  readonly locale?: string;
}
export interface PlatformObservationV1 {
  readonly requested: PlatformPreferencesV1;
  readonly observed: 'unknown' | 'supported' | 'unsupported' | 'coupled';
}
export type ExtensionAssetsV1 =
  | { readonly baseURL: string; readonly manifest?: never }
  | { readonly baseURL?: never; readonly manifest: Readonly<Record<string, string>> };
export interface EditorExtensionConfigurationV1 {
  readonly apiVersion: 1;
  readonly extensions: readonly ConfiguredExtensionV1[];
  readonly formatting?: CoreFormattingV1;
  readonly collaboration?: false | CollaborationConfigurationV1;
  readonly platform?: PlatformPreferencesV1;
  readonly assets?: ExtensionAssetsV1;
  /** Convenience only: callers expand inspectable lists; task/minimal remain legacy SDK names. */
  readonly preset?: 'default' | 'document';
  /** Mixing facade configuration and old assembly fails; no silent precedence. */
  readonly legacy?: Readonly<Partial<Record<'modules' | 'moduleRuntime' | 'markdown' | 'content' | 'codeHighlight' | 'references' | 'links' | 'slash' | 'reorder' | 'typingShortcuts' | 'preset', unknown>>>;
}
export interface PreparedEditorConfigurationV1 {
  readonly apiVersion: 1;
  readonly profile: PreparedProfile;
  readonly configuration: ExtensionReadonlyV1<Omit<EditorExtensionConfigurationV1, 'legacy'>>;
  readonly extensions: readonly ConfiguredExtensionV1[];
  readonly requiredReady: readonly string[];
  readonly localReadyWithoutProvider: boolean;
}
export class ExtensionConfigurationError extends Error {
  constructor(readonly code: string, readonly extension: string, readonly option: string, readonly remedy: string) {
    super(`${extension}.${option}: ${code}; ${remedy}`); this.name = 'ExtensionConfigurationError';
  }
}
const fail = (code: string, extension: string, option: string, remedy: string): never => { throw new ExtensionConfigurationError(code, extension, option, remedy); };
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); }
  return value;
}
function data<T>(value: T, id = 'editor', option = 'configuration'): T {
  try { return frozen(copyModuleData(value)) as T; }
  catch { return fail('invalid-data', id, option, 'Use bounded portable JSON data without getters, cycles, callbacks or custom prototypes'); }
}
const operations: readonly Patch['operation'][] = ['Text', 'Format', 'Structure', 'Editor', 'Remote', 'Undo', 'Redo', 'Selection'];
function interests(input: readonly ModuleScope[], id: string): readonly ModuleScope[] {
  const result = data(input);
  for (const scope of result) {
    if (Object.keys(scope).some(k => !['kinds', 'range', 'selection'].includes(k)) || !Array.isArray(scope.kinds) ||
        !scope.kinds.every(k => operations.includes(k)) || new Set(scope.kinds).size !== scope.kinds.length ||
        (scope.selection !== undefined && typeof scope.selection !== 'boolean') ||
        (scope.range && (typeof scope.range.source !== 'string' || !scope.range.source.length ||
          !Number.isSafeInteger(scope.range.start) || !Number.isSafeInteger(scope.range.end) || scope.range.start < 0 || scope.range.end < scope.range.start)))
      fail('invalid-interest', id, 'interests', 'Declare operation kinds and a valid source-local UTF-16 range; use kinds: [] for selection only');
  }
  return result;
}
/** Freeze small metadata/options only. This function neither loads nor attaches anything. */
export function defineExtensionContract<Options extends Record<string, Json>>(definition: ExtensionDefinitionV1<Options>): ExtensionFactoryV1<Options> {
  const id = definition.feature.id;
  if (definition.apiVersion !== 1) fail('unsupported-api', id, 'apiVersion', 'Use API version 1');
  if (!['required-input', 'command-lazy', 'presentation-lazy'].includes(definition.loading)) fail('invalid-loading', id, 'loading', 'Declare a supported load policy');
  if (!['behavior', 'data'].includes(definition.semantics.kind)) fail('engine-semantic', id, 'semantics', 'Implement new semantics in the shared engine owner');
  if ((definition.semantics.kind === 'behavior' && definition.feature.definition) ||
      (definition.semantics.kind === 'data' && JSON.stringify(definition.feature.definition) !== JSON.stringify(definition.semantics.definition)))
    fail('definition-mismatch', id, 'semantics', 'Use the same admitted mark/inline-atom definition in the portable descriptor');
  const feature = data(definition.feature), semantics = data(definition.semantics), defaults = data(definition.defaults);
  const scopes = interests(definition.interests, id), loading = definition.loading, validate = definition.validateOptions;
  return Object.freeze({ name: id, version: feature.version, configure(overrides: Partial<Options> = {}): ConfiguredExtensionV1<Options> {
    const supplied = data(overrides, id, 'options');
    for (const key of Object.keys(supplied)) if (!Object.hasOwn(defaults, key)) fail('unknown-option', id, key, 'Use a declared option');
    const options = data({ ...defaults, ...supplied });
    let valid = false;
    try { valid = validate(options as ExtensionReadonlyV1<Options>); } catch { /* retain bounded diagnostic; never stringify callback errors */ }
    if (!valid) fail('invalid-option', id, 'options', 'Supply values accepted by this extension');
    return Object.freeze({ apiVersion: 1, feature, semantics, options: options as ExtensionReadonlyV1<Options>, interests: scopes, loading });
  } });
}
/** Admission happens once, before reserve/recovery/attachment. Execution stays in existing owners. */
export function prepareEditorExtensionConfiguration(input: EditorExtensionConfigurationV1, environment: ProfileEnvironment): PreparedEditorConfigurationV1 {
  if (input.apiVersion !== 1) fail('unsupported-api', 'editor', 'apiVersion', 'Use API version 1');
  if (input.legacy && Object.keys(input.legacy).length) fail('legacy-conflict', 'editor', 'legacy', 'Keep the legacy call unchanged or migrate all assembly options to extensions');
  if (input.preset !== undefined && !['default', 'document'].includes(input.preset)) fail('invalid-preset', 'editor', 'preset', 'Use an inspectable default/document convenience list, or omit preset');
  for (const [mark, rule] of Object.entries(input.formatting?.marks ?? {})) {
    if (!['bold', 'italic', 'strike', 'underline', 'code', 'link'].includes(mark) || !rule ||
        Object.entries(rule).some(([k,v]) => !['commands', 'shortcuts', 'controls'].includes(k) || typeof v !== 'boolean') ||
        (rule.commands === false && (rule.shortcuts !== false || rule.controls !== false)))
      fail('invalid-formatting', 'editor', `formatting.${mark}`, 'Disable shortcuts and controls explicitly when disabling a command');
  }
  const sync = input.collaboration;
  if (sync && (typeof sync.connect !== 'function' || (sync.readiness !== undefined && !['local', 'remote'].includes(sync.readiness)) ||
      (sync.presence && (typeof sync.presence.awareness !== 'boolean' || typeof sync.presence.peerCarets !== 'boolean' || (sync.presence.peerCarets && !sync.presence.awareness)))))
    fail('invalid-collaboration', 'editor', 'collaboration', 'Provide a host connector; peer carets require explicit awareness');
  if (input.platform && ((input.platform.spellcheck !== undefined && !['platform','off','custom'].includes(input.platform.spellcheck)) ||
      (input.platform.autocorrection !== undefined && !['inherit','on','off'].includes(input.platform.autocorrection))))
    fail('invalid-platform', 'editor', 'platform', 'Select independent spelling/autocorrection preferences; do not infer observed support');
  if (input.assets) {
    const a = input.assets;
    if (('baseURL' in a) === ('manifest' in a)) fail('invalid-assets', 'editor', 'assets', 'Provide one base URL or one manifest');
    const urls = a.baseURL !== undefined ? [a.baseURL] : Object.values(a.manifest ?? {});
    if (urls.some(url => { try { return !['https:', 'http:'].includes(new URL(url).protocol); } catch { return true; } }))
      fail('invalid-assets', 'editor', 'assets', 'Use absolute HTTP(S) versioned URLs for host overrides');
  }
  const entries = input.extensions.map(extension => {
    if (extension.apiVersion !== 1) fail('unsupported-api', extension.feature.id, 'apiVersion', 'Use API version 1');
    interests(extension.interests, extension.feature.id);
    return data(extension);
  });
  let profile: PreparedProfile;
  try {
    profile = prepareExtensionProfile({ apiVersion: 1, id: 'web.configuration', version: 1,
      features: entries.map(e => ({ id: e.feature.id, version: e.feature.version })) }, entries.map(e => e.feature as ProfileFeature), environment);
  } catch (error) {
    if (error instanceof ProfileError) fail(error.code, 'editor', 'extensions', `${error.message}; correct the portable descriptor, prerequisites or explicit binding remap`);
    throw error;
  }
  const configured = Object.freeze(entries);
  const configuration: Omit<EditorExtensionConfigurationV1, 'legacy'> = Object.freeze({
    apiVersion: 1, extensions: configured,
    ...(input.preset !== undefined ? { preset: input.preset } : {}),
    ...(input.formatting ? { formatting: data(input.formatting) } : {}),
    ...(input.platform ? { platform: data(input.platform) } : {}),
    ...(input.assets ? { assets: data(input.assets) } : {}),
    ...(sync ? { collaboration: Object.freeze({ connect: sync.connect,
      ...(sync.readiness !== undefined ? { readiness: sync.readiness } : {}),
      ...(sync.presence ? { presence: data(sync.presence) } : {}) }) } : { collaboration: false }),
  });
  return Object.freeze({ apiVersion: 1, profile, configuration, extensions: configured,
    requiredReady: Object.freeze(entries.filter(e => e.loading === 'required-input').map(e => e.feature.id)),
    localReadyWithoutProvider: !sync || sync.readiness !== 'remote' });
}
