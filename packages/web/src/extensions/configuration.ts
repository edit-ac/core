import { FIRST_PARTY_FEATURES } from '@edit-ac/core/extensions';
import type { ProfileEnvironment } from '@edit-ac/core/extensions';
import { documentSearch } from '../modules/search.js';
import { reorderControls } from '../modules/reorder.js';
import { slashCommands, type SlashCommand, type SlashFactory } from '../modules/slash.js';
import { referenceSuggestions, type ReferenceHostV1, type ReferenceResolver, type ReferenceFactory } from '../modules/references.js';
import { mathModuleDefinition } from '../modules/math-definition.js';
import { managedMathRenderer } from './math.js';
import { defineExtensionContract, prepareEditorExtensionConfiguration, ExtensionConfigurationError } from './contract.js';
import type { ConfiguredExtensionV1, EditorExtensionConfigurationV1, PreparedEditorConfigurationV1 } from './contract.js';
import type { EditorSurfaceOptions } from '../surface.js';

export interface EditorFacadeOptionsV1 extends Pick<EditorExtensionConfigurationV1, 'extensions' | 'formatting' | 'collaboration' | 'platform' | 'assets'> {
  /** Actual host capabilities/permissions; fixture admission is never enabled implicitly. */
  extensionEnvironment?: ProfileEnvironment;
}
function builtin(name: string) {
  const feature = FIRST_PARTY_FEATURES.find(f => f.id === `editac.${name}`)!;
  return defineExtensionContract<Record<string, never>>({ apiVersion: 1, feature, semantics: { kind: 'behavior' },
    defaults: {}, validateOptions: () => true, loading: 'required-input', interests: [] });
}
/** Small descriptors adapt existing qualified presenters; no document or dispatcher. */
export const DocumentSearch = builtin('search');
export const BlockReorder = builtin('reorder');
/** Source-preserving qualified content presenters; asset services stay host-owned. */
export const Images = builtin('images');
export const Tables = builtin('tables');
const mathFeature = { ...FIRST_PARTY_FEATURES.find(f => f.id === 'editac.math')!, definition: mathModuleDefinition };
export const MathNotation = defineExtensionContract<Record<string, never>>({ apiVersion: 1, feature: mathFeature,
  semantics: { kind: 'data', definition: mathModuleDefinition }, defaults: {}, validateOptions: () => true, loading: 'required-input', interests: [] });
const referenceContract = defineExtensionContract<{ triggers: string[] }>({ apiVersion: 1,
  feature: FIRST_PARTY_FEATURES.find(f => f.id === 'editac.references')!, semantics: { kind: 'behavior' },
  defaults: { triggers: [] }, validateOptions: options => Array.isArray(options.triggers) && options.triggers.length <= 16 && options.triggers.every(t => typeof t === 'string'),
  loading: 'required-input', interests: [] });
const slashContract = defineExtensionContract<{ literal: boolean; commands: string[] }>({ apiVersion: 1,
  feature: FIRST_PARTY_FEATURES.find(f => f.id === 'editac.slash')!, semantics: { kind: 'behavior' },
  defaults: { literal: false, commands: [] }, validateOptions: options => typeof options.literal === 'boolean' && Array.isArray(options.commands) && options.commands.length <= 500 && options.commands.every(t => typeof t === 'string'),
  loading: 'required-input', interests: [] });
interface HostAdapters { references?: ReferenceFactory; slash?: SlashFactory }
const configuredHosts = new WeakMap<ConfiguredExtensionV1, HostAdapters>();
const preparedHosts = new WeakMap<PreparedEditorConfigurationV1, HostAdapters>();
export interface ReferenceConfigurationV1 { host: ReferenceHostV1 | ReferenceResolver; triggers?: readonly string[] }
export const References = Object.freeze({ name: referenceContract.name, version: referenceContract.version,
  configure(options: ReferenceConfigurationV1) {
    const host = options.host;
    if (!host || (typeof host !== 'function' && (host.version !== 1 || ['permission','catalog','resolve','subscribe'].some(key => typeof host[key as keyof ReferenceHostV1] !== 'function'))))
      throw new ExtensionConfigurationError('invalid-option', referenceContract.name, 'host', 'Provide the existing reference resolver or versioned host contract');
    const captured = typeof host === 'function' ? host : Object.freeze({ version: host.version,
      permission: host.permission.bind(host), catalog: host.catalog.bind(host), resolve: host.resolve.bind(host), subscribe: host.subscribe.bind(host) });
    const value = referenceContract.configure({ triggers: [...(options.triggers ?? [])] });
    configuredHosts.set(value, Object.freeze({ references: referenceSuggestions(captured, { triggers: [...value.options.triggers] }) }));
    return value;
  } });
export interface SlashConfigurationV1 { commands: readonly SlashCommand[]; literal?: boolean }
export const SlashCommands = Object.freeze({ name: slashContract.name, version: slashContract.version,
  configure(options: SlashConfigurationV1) {
    let factory: SlashFactory;
    try { factory = slashCommands(options.commands, { literal: options.literal ?? false }); } catch {
      throw new ExtensionConfigurationError('invalid-option', slashContract.name, 'commands', 'Provide unique bounded command metadata and prepare callbacks');
    }
    const value = slashContract.configure({ literal: options.literal ?? false, commands: options.commands.map(c => c.id) });
    configuredHosts.set(value, Object.freeze({ slash: factory })); return value;
  } });
const markdownFeature = { ...FIRST_PARTY_FEATURES.find(f => f.id === 'editac.search')!, id: 'editac.markdown',
  capabilities: ['source-fallback'], bindings: [], owner: 'formats/markdown' };
const markdownContract = defineExtensionContract<{ input: boolean }>({ apiVersion: 1, feature: markdownFeature,
  semantics: { kind: 'behavior' }, defaults: { input: true }, validateOptions: options => typeof options.input === 'boolean',
  loading: 'required-input', interests: [] });
/** Optional @edit-ac/markdown installation; implementation loads only on activation. */
export const Markdown = Object.freeze({ name: markdownContract.name, version: markdownContract.version,
  configure(options: { input?: boolean } = {}) {
    const value = markdownContract.configure(options);
    return Object.freeze({ ...value, loading: value.options.input ? 'required-input' as const : 'command-lazy' as const });
  } });
export interface ExtensionPresetOverridesV1 {
  extensions?: readonly ConfiguredExtensionV1[];
  remove?: readonly string[];
  overrides?: readonly ConfiguredExtensionV1[];
}
function preset(name: 'default' | 'document', options: ExtensionPresetOverridesV1 = {}) {
  const base = name === 'document' ? [DocumentSearch.configure(), BlockReorder.configure()] : [];
  const removed = new Set(options.remove ?? []);
  const selected = [...base, ...(options.extensions ?? [])].filter(e => !removed.has(e.feature.id));
  for (const override of options.overrides ?? []) {
    const index = selected.findIndex(e => e.feature.id === override.feature.id);
    if (index < 0) throw new ExtensionConfigurationError('missing-override', override.feature.id, 'overrides', 'Add the extension before overriding it');
    selected[index] = override;
  }
  return Object.freeze({ preset: name, extensions: Object.freeze(selected) });
}
/** Inspectable Task editing defaults; network/presence are never inferred. */
export function defaultPreset(options: ExtensionPresetOverridesV1 = {}) { return preset('default', options); }
/** Qualified local document tools; host services remain explicit selections. */
export function documentPreset(options: ExtensionPresetOverridesV1 = {}) { return preset('document', options); }
export function configuredEngineAsset(assetUrl: string, prepared?: PreparedEditorConfigurationV1): string {
  const assets = prepared?.configuration.assets;
  return assets?.baseURL ? new URL('editac_wasm_bg.wasm', assets.baseURL).href : assets?.manifest?.engine ?? assetUrl;
}
const adapters = new Map([DocumentSearch, BlockReorder, Images, Tables, MathNotation, Markdown, referenceContract, slashContract].map(factory => [factory.name, factory]));
const legacy = ['modules','moduleRuntime','markdown','content','codeHighlight','references','links','slash','reorder','typingShortcuts','preset','search','codeCommands','shortcutProfile','commandAllowed','inputHints'] as const;
export function prepareSurfaceConfiguration(options: EditorSurfaceOptions, schema: string): PreparedEditorConfigurationV1 | undefined {
  const facade = options.preset === 'default' || options.preset === 'document' || options.extensions !== undefined || options.formatting !== undefined || options.collaboration !== undefined || options.platform !== undefined || options.assets !== undefined;
  if (!facade) return undefined;
  for (const key of legacy) if (Object.hasOwn(options, key) && !(key === 'preset' && (options.preset === 'default' || options.preset === 'document'))) throw new ExtensionConfigurationError('legacy-conflict', 'editor', key, 'Move assembly options together; use either the facade or legacy configuration');
  if (options.extensionEnvironment && options.extensionEnvironment.schema !== schema) throw new ExtensionConfigurationError('incompatible-schema', 'editor', 'extensionEnvironment.schema', 'Use the actual document schema');
  const hosts: HostAdapters = {};
  for (const extension of options.extensions ?? []) {
    if (['editac.references','editac.slash'].includes(extension.feature.id)) {
      const captured = configuredHosts.get(extension);
      if (!captured) throw new ExtensionConfigurationError('missing-host', extension.feature.id, 'extensions', 'Keep the original configured value with its explicit host callbacks');
      Object.assign(hosts, captured);
    }
  }
  const prepared = prepareEditorExtensionConfiguration({ apiVersion: 1, extensions: options.extensions ?? (options.preset === 'document' ? documentPreset().extensions : []),
    ...((options.preset === 'default' || options.preset === 'document') ? { preset: options.preset } : {}),
    ...(options.formatting ? { formatting: options.formatting } : {}), ...(options.collaboration !== undefined ? { collaboration: options.collaboration } : {}),
    ...(options.platform ? { platform: options.platform } : {}), ...(options.assets ? { assets: options.assets } : {}) }, options.extensionEnvironment ?? { schema, capabilities: ['commands','source-fallback', ...(hosts.references ? ['host-resolver'] : [])] });
  if (prepared.configuration.platform?.spellcheck === 'custom') throw new ExtensionConfigurationError('missing-checker', 'editor', 'platform.spellcheck', 'Custom checking requires the explicit checker adapter delivered by EXT-1.18');
  for (const extension of prepared.extensions) {
    const factory = adapters.get(extension.feature.id);
    if (!factory || JSON.stringify(extension) !== JSON.stringify(factory.configure(extension.options as never))) throw new ExtensionConfigurationError('missing-adapter', extension.feature.id, 'extensions', 'Use an unchanged shipped facade factory; authoring adapters are delivered by EXT-1.15');
  }
  preparedHosts.set(prepared, Object.freeze(hosts));
  return prepared;
}
/** Called once per attachment, outside input dispatch. */
export function configuredSurfaceOptions(options: EditorSurfaceOptions, prepared?: PreparedEditorConfigurationV1): EditorSurfaceOptions {
  if (!prepared) return options;
  const result: EditorSurfaceOptions = { ...options, modules: prepared.profile.registry };
  Object.assign(result, preparedHosts.get(prepared));
  result.contentCodecs = { images: prepared.extensions.some(e => e.feature.id === 'editac.images'), tables: prepared.extensions.some(e => e.feature.id === 'editac.tables') };
  for (const extension of prepared.extensions) {
    if (extension.feature.id === 'editac.search') result.search = documentSearch();
    if (extension.feature.id === 'editac.reorder') result.reorder = reorderControls();
    if (extension.feature.id === 'editac.math') result.moduleRuntime = { renderers: { 'editac.math': managedMathRenderer(prepared.configuration.assets) }, presentations: { 'editac.math': { tag: 'span' } } };
  }
  const marks = prepared.configuration.formatting?.marks;
  if (marks) {
    result.commandAllowed = command => !(command in marks) || marks[command as keyof typeof marks]?.commands !== false;
    result.shortcutProfile = { reserved: Object.entries(marks).filter(([, policy]) => policy.shortcuts === false).flatMap(([mark]) => {
      const chords: Record<string, string> = { bold: 'Primary+b', italic: 'Primary+i', underline: 'Primary+u', strike: 'Primary+Shift+x', link: 'Primary+k' };
      return chords[mark] ? [chords[mark]!] : [];
    }) };
  }
  return result;
}
