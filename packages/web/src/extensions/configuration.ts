import { FIRST_PARTY_FEATURES } from '@edit-ac/core/extensions';
import type { ProfileEnvironment } from '@edit-ac/core/extensions';
import { documentSearch } from '../modules/search.js';
import { reorderControls } from '../modules/reorder.js';
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
const adapters = new Set(['editac.search', 'editac.reorder']);
const legacy = ['modules','moduleRuntime','markdown','content','codeHighlight','references','links','slash','reorder','typingShortcuts','preset','search','codeCommands','shortcutProfile','commandAllowed','inputHints'] as const;
export function prepareSurfaceConfiguration(options: EditorSurfaceOptions, schema: string): PreparedEditorConfigurationV1 | undefined {
  const facade = options.preset === 'default' || options.preset === 'document' || options.extensions !== undefined || options.formatting !== undefined || options.collaboration !== undefined || options.platform !== undefined || options.assets !== undefined;
  if (!facade) return undefined;
  for (const key of legacy) if (Object.hasOwn(options, key) && !(key === 'preset' && (options.preset === 'default' || options.preset === 'document'))) throw new ExtensionConfigurationError('legacy-conflict', 'editor', key, 'Move assembly options together; use either the facade or legacy configuration');
  if (options.extensionEnvironment && options.extensionEnvironment.schema !== schema) throw new ExtensionConfigurationError('incompatible-schema', 'editor', 'extensionEnvironment.schema', 'Use the actual document schema');
  const prepared = prepareEditorExtensionConfiguration({ apiVersion: 1, extensions: options.extensions ?? (options.preset === 'document' ? documentPreset().extensions : []),
    ...((options.preset === 'default' || options.preset === 'document') ? { preset: options.preset } : {}),
    ...(options.formatting ? { formatting: options.formatting } : {}), ...(options.collaboration !== undefined ? { collaboration: options.collaboration } : {}),
    ...(options.platform ? { platform: options.platform } : {}), ...(options.assets ? { assets: options.assets } : {}) }, options.extensionEnvironment ?? { schema, capabilities: ['commands','source-fallback'] });
  if (prepared.configuration.platform?.spellcheck === 'custom') throw new ExtensionConfigurationError('missing-checker', 'editor', 'platform.spellcheck', 'Custom checking requires the explicit checker adapter delivered by EXT-1.18');
  for (const extension of prepared.extensions) if (!adapters.has(extension.feature.id) || Object.keys(extension.options).length || JSON.stringify(extension.feature) !== JSON.stringify(FIRST_PARTY_FEATURES.find(f => f.id === extension.feature.id)) || extension.semantics.kind !== 'behavior') throw new ExtensionConfigurationError('missing-adapter', extension.feature.id, 'extensions', 'Use a shipped facade factory; authoring adapters are delivered by EXT-1.15');
  return prepared;
}
/** Called once per attachment, outside input dispatch. */
export function configuredSurfaceOptions(options: EditorSurfaceOptions, prepared?: PreparedEditorConfigurationV1): EditorSurfaceOptions {
  if (!prepared) return options;
  const result: EditorSurfaceOptions = { ...options, modules: prepared.profile.registry };
  for (const extension of prepared.extensions) {
    if (extension.feature.id === 'editac.search') result.search = documentSearch();
    if (extension.feature.id === 'editac.reorder') result.reorder = reorderControls();
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
