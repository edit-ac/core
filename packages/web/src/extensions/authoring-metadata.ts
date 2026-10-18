import type { ExtensionHooksV1 } from './authoring.js';
import type { attachAuthoring } from './authoring.js';
import type { Json } from '@edit-ac/core';
import type { ModuleRenderer } from '../modules/runtime.js';
import { literalShortcuts } from '../input/shortcuts.js';
import type { MarkdownCodec } from '@edit-ac/core';
import { validateClipboardCodecs, type ClipboardCodec } from '../clipboard/fragment.js';
import { ExtensionConfigurationError } from './contract.js';
import type { ConfiguredExtensionV1, PreparedEditorConfigurationV1 } from './contract.js';

export const authored = new WeakMap<ConfiguredExtensionV1, ExtensionHooksV1<Record<string, Json>>>();
export const admitted = new WeakMap<PreparedEditorConfigurationV1, readonly { value: ConfiguredExtensionV1; hooks: ExtensionHooksV1<Record<string, Json>> }[]>();
const error = (id: string, option: string, remedy: string): never => { throw new ExtensionConfigurationError('invalid-authoring', id, option, remedy); };

export const attachments = new WeakMap<ConfiguredExtensionV1, typeof attachAuthoring>();
const preparedAttachments = new WeakMap<PreparedEditorConfigurationV1, typeof attachAuthoring>();

export function isAuthored(value: ConfiguredExtensionV1): boolean { return authored.has(value); }
export function admitAuthoring(prepared: PreparedEditorConfigurationV1, originals: readonly ConfiguredExtensionV1[]): void {
  const attach = originals.map(value => attachments.get(value)).find(value => value !== undefined);
  if (attach) preparedAttachments.set(prepared, attach);
  admitted.set(prepared, originals.flatMap((value, index) => {
    const hooks = authored.get(value); return hooks ? [{ value: prepared.extensions[index]!, hooks }] : [];
  }));
}
const preparedAdapters = new WeakMap<PreparedEditorConfigurationV1, { renderers: Readonly<Record<string, ModuleRenderer>>; markdown: { codec: MarkdownCodec; createShortcuts: typeof literalShortcuts } | undefined; clipboardCodecs: readonly ClipboardCodec[] }>();
export function authoringAdapters(prepared: PreparedEditorConfigurationV1) {
  const cached = preparedAdapters.get(prepared); if (cached) return cached;
  const entries = admitted.get(prepared) ?? [];
  const priorities = new Map<string, Set<number>>();
  for (const { value, hooks } of entries) for (const rule of hooks.input ?? []) {
    const key = `${rule.type}:${rule.key}`, seen = priorities.get(key) ?? new Set<number>();
    if (seen.has(rule.priority)) error(value.feature.id, 'input', 'Resolve equal input priorities before attachment');
    seen.add(rule.priority); priorities.set(key, seen);
  }
  const codecs = entries.flatMap(e => e.hooks.clipboardCodecs ?? []); validateClipboardCodecs(codecs);
  const markdown = entries.filter(e => e.hooks.markdown);
  if (markdown.length + prepared.extensions.filter(e => e.feature.id === 'editac.markdown').length > 1) error('editor', 'markdown', 'Select one Markdown adapter');
  const adapters = Object.freeze({ renderers: Object.freeze(Object.assign({}, ...entries.map(e => e.hooks.renderers))) as Record<string, ModuleRenderer>,
    markdown: markdown[0]?.hooks.markdown ? { codec: markdown[0].hooks.markdown, createShortcuts: literalShortcuts } : undefined, clipboardCodecs: Object.freeze(codecs) });
  preparedAdapters.set(prepared, adapters); return adapters;
}

export function attachConfiguredAuthoring(...args: Parameters<typeof attachAuthoring>): ReturnType<typeof attachAuthoring> {
  const attach = args[0] && preparedAttachments.get(args[0]);
  if (attach) return attach(...args);
  return { dispose() {}, diagnostics: [], hasInput: false, handle: () => false,
    runCommand(id: string, name: string) { throw new ExtensionConfigurationError('unknown-command', id, name, 'Use a configured extension command'); } };
}
