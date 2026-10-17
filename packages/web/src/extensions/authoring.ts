import { attachPatternMatching, type PatternOptionsV1, type PatternControllerV1, type PatternPorts } from './matching.js';
import type { Json, PrepareRequest, PatchSubscription } from '@edit-ac/core';
import type { ModuleRenderer, ModuleRuntime, ModuleScope } from '../modules/runtime.js';
import { literalShortcuts } from '../input/shortcuts.js';
import type { MarkdownCodec } from '@edit-ac/core';
import { validateClipboardCodecs, type ClipboardCodec } from '../clipboard/fragment.js';
import { defineExtensionContract, ExtensionConfigurationError } from './contract.js';
import type { ConfiguredExtensionV1, ExtensionCallbackContextV1, ExtensionDefinitionV1, ExtensionReadonlyV1, ExtensionAuthoringV1, PreparedEditorConfigurationV1 } from './contract.js';

/** Input metadata is copied, bounded and local. No DOM event or writable model. */
export interface ExtensionInputV1 { readonly type: 'key' | 'input' | 'paste'; readonly key: string; readonly text: string; readonly primary: boolean; readonly shift: boolean; readonly alt: boolean }
export interface ExtensionDiagnosticV1 { readonly extension: string; readonly phase: 'attach' | 'patch' | 'resource' | 'input' | 'dispose' }
export interface ExtensionContextV1 extends ExtensionCallbackContextV1 {
  readonly match: (options: PatternOptionsV1) => PatternControllerV1;
  readonly captureTarget: () => { readonly range: import('@edit-ac/core').StableRange; dispose(): void } | undefined;
  readonly command: (name: string, argument?: Json) => import('@edit-ac/core').CommitResult | undefined;
  /** Resources are per attachment. Late completion is disposed after abort. */
  readonly manage: (load: (signal: AbortSignal) => Promise<{ dispose(): void }>) => Promise<boolean>;
  readonly cleanup: (dispose: () => void) => () => void;
}
export interface ExtensionHooksV1<Options extends Record<string, Json>> extends Omit<ExtensionAuthoringV1<Options>, 'onAttach' | 'onPatch'> {
  readonly onAttach?: (options: ExtensionReadonlyV1<Options>, context: ExtensionContextV1) => void | (() => void);
  readonly onPatch?: (event: import('../modules/runtime.js').ModuleEvent, context: ExtensionContextV1) => void;
  readonly commands?: Readonly<Record<string, (argument: Json | undefined, context: ExtensionContextV1, options: ExtensionReadonlyV1<Options>) => PrepareRequest | undefined>>;
  /** Descending priority; equal priorities for one key reject before attachment. */
  readonly input?: readonly { readonly type: ExtensionInputV1['type']; readonly key: string; readonly priority: number; readonly prepare: (input: ExtensionInputV1, context: ExtensionContextV1, options: ExtensionReadonlyV1<Options>) => PrepareRequest | undefined }[];
  /** Existing decoration owner; missing/throwing presenters preserve source. */
  readonly renderers?: Readonly<Record<string, ModuleRenderer>>;
  readonly markdown?: MarkdownCodec;
  readonly clipboardCodecs?: readonly ClipboardCodec[];
}
export type ExtensionCreateV1<Options extends Record<string, Json>> = ExtensionDefinitionV1<Options> & ExtensionHooksV1<Options>;
const authored = new WeakMap<ConfiguredExtensionV1, ExtensionHooksV1<Record<string, Json>>>();
const admitted = new WeakMap<PreparedEditorConfigurationV1, readonly { value: ConfiguredExtensionV1; hooks: ExtensionHooksV1<Record<string, Json>> }[]>();
const error = (id: string, option: string, remedy: string): never => { throw new ExtensionConfigurationError('invalid-authoring', id, option, remedy); };

export const Extension = Object.freeze({
  create<Options extends Record<string, Json>>(definition: ExtensionCreateV1<Options>) {
    const factory = defineExtensionContract(definition), id = factory.name;
    if (id.startsWith('editac.')) error(id, 'feature.id', 'Use your own namespace');
    if (Object.keys(definition.commands ?? {}).length > 64 || (definition.input?.length ?? 0) > 64 || definition.interests.length > 64) error(id, 'limits', 'Use at most 64 commands, input rules and interests');
    for (const key of ['onAttach', 'onPatch'] as const) if (definition[key] !== undefined && typeof definition[key] !== 'function') error(id, key, 'Supply a synchronous callback');
    if (definition.onPatch && !definition.interests.length) error(id, 'interests', 'Declare bounded interests for onPatch');
    const commands = Object.freeze({ ...definition.commands });
    for (const [name, command] of Object.entries(commands)) if (!/^[a-z][a-zA-Z0-9-]{0,63}$/.test(name) || typeof command !== 'function') error(id, 'commands', 'Use named prepared command callbacks');
    const seen = new Set<string>();
    const input = Object.freeze((definition.input ?? []).map(rule => {
      const identity = `${rule.type}:${rule.key}`;
      if (!['key','input','paste'].includes(rule.type) || !rule.key || rule.key.length > 128 || !Number.isSafeInteger(rule.priority) || typeof rule.prepare !== 'function' || seen.has(identity)) error(id, 'input', 'Declare unique bounded input keys and integer priorities');
      seen.add(identity); return Object.freeze({ ...rule });
    }));
    const renderers = Object.freeze(Object.fromEntries(Object.entries(definition.renderers ?? {}).map(([type, renderer]) => {
      if (definition.semantics.kind !== 'data' || type !== definition.semantics.definition.type || typeof renderer.mount !== 'function') error(id, 'renderers', 'Present only this extension’s admitted data type');
      return [type, Object.freeze({ mount: renderer.mount.bind(renderer) })];
    })));
    const codec = definition.markdown;
    if (codec && (typeof codec.importMarkdown !== 'function' || typeof codec.exportMarkdown !== 'function')) error(id, 'markdown', 'Provide a pure source-preserving Markdown codec');
    const markdown = codec ? Object.freeze({ importMarkdown: codec.importMarkdown.bind(codec), exportMarkdown: codec.exportMarkdown.bind(codec) }) : undefined;
    const clipboardCodecs = Object.freeze((definition.clipboardCodecs ?? []).map(codec => {
      if (typeof codec.prepare !== 'function') error(id, 'clipboardCodecs', 'Provide a pure prepared-fragment codec');
      return Object.freeze({ mime: codec.mime, prepare: codec.prepare.bind(codec) });
    }));
    validateClipboardCodecs(clipboardCodecs);
    const hooks = Object.freeze({ onAttach: definition.onAttach, onPatch: definition.onPatch, commands, input, renderers,
      markdown, clipboardCodecs });
    return Object.freeze({ name: factory.name, version: factory.version, configure(options: Partial<Options> = {}) {
      const value = factory.configure(options); authored.set(value, hooks as ExtensionHooksV1<Record<string, Json>>); return value;
    } });
  },
});
export function isAuthored(value: ConfiguredExtensionV1): boolean { return authored.has(value); }
export function admitAuthoring(prepared: PreparedEditorConfigurationV1, originals: readonly ConfiguredExtensionV1[]): void {
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

/** Lifecycle adapter only: ModuleRuntime owns all committed-event dispatch. */
export function attachAuthoring(prepared: PreparedEditorConfigurationV1 | undefined, runtime: ModuleRuntime | undefined,
  ports: Pick<ExtensionCallbackContextV1, 'can' | 'commit' | 'captureCommand'> & { blocked(): boolean; captureTarget: ExtensionContextV1['captureTarget']; matching?: PatternPorts }) {
  const controller = new AbortController(), cleanups = new Set<() => void>();
  const commands = new Map<string, ExtensionContextV1>();
  const inputs = new Map<string, { priority: number; run(input: ExtensionInputV1): boolean }[]>();
  const diagnostics: ExtensionDiagnosticV1[] = [];
  let pending = 0;
  const report = (extension: string, phase: ExtensionDiagnosticV1['phase']) => { if (diagnostics.length === 64) diagnostics.shift(); diagnostics.push({ extension, phase }); };
  const live = () => { if (controller.signal.aborted || ports.blocked()) throw Error('Extension attachment is readonly, composing, unready or disposed'); };
  const own = (dispose: () => void): (() => void) => {
    let active = true;
    const release = () => { if (!active) return; active = false; cleanups.delete(release); dispose(); };
    if (controller.signal.aborted) { release(); return release; }
    if (cleanups.size >= 512) { release(); throw Error('Extension cleanup limit reached'); }
    cleanups.add(release); return release;
  };
  const dispose = () => { if (controller.signal.aborted) return; controller.abort(); for (const cleanup of [...cleanups].reverse()) try { cleanup(); } catch { report('editor','dispose'); } inputs.clear(); commands.clear(); };
  try {
    for (const { value, hooks } of prepared ? admitted.get(prepared) ?? [] : []) {
      const id = value.feature.id;
      let subscriptions = 0;
      let commandTargets: (() => void)[] | undefined;
      const apply = (prepare: () => PrepareRequest | undefined) => {
        const previous = commandTargets, held: (() => void)[] = []; commandTargets = held;
        try { const request = prepare(); return request ? context.commit(request) : undefined; }
        finally { for (const release of held.reverse()) release(); commandTargets = previous; }
      };
      const subscribe = (scope: ModuleScope, callback: Parameters<ModuleRuntime['subscribe']>[1]): PatchSubscription => {
        if (controller.signal.aborted || !runtime) throw Error('Extension runtime unavailable');
        // Explicit kinds are mandatory, including [] for selection only.
        if (++subscriptions > 64) throw Error('Extension subscription limit reached');
        if (!Array.isArray(scope.kinds)) throw Error('Declare operation interests explicitly');
        const subscription = runtime.subscribe(scope, callback); own(() => subscription.dispose()); return subscription;
      };
      const context: ExtensionContextV1 = Object.freeze<ExtensionContextV1>({ signal: controller.signal, generation: 1,
        match: options => { if (controller.signal.aborted) throw Error('Extension attachment disposed'); if (!ports.matching) throw Error('Matching projection unavailable'); return attachPatternMatching(options, context, ports.matching); },
        can: request => !controller.signal.aborted && !ports.blocked() && ports.can(request),
        commit: request => { live(); return ports.commit(request); },
        captureCommand: (name, target) => {
          live(); const captured = ports.captureCommand(name, target); if (!captured) return undefined;
          const release = own(() => captured.dispose()); commandTargets?.push(release);
          return { get active() { return !controller.signal.aborted && captured.active; }, dispose: release, execute: (...args: Parameters<typeof captured.execute>) => { live(); return captured.execute(...args); } };
        },
        captureTarget: () => { live(); const target = ports.captureTarget(); if (!target) return undefined;
          const release = own(() => target.dispose()); commandTargets?.push(release);
          return Object.freeze({ range: Object.freeze({ ...target.range }), dispose: release }); },
        subscribe, cleanup: own,
        command: (name, argument) => { live(); return apply(() => hooks.commands?.[name]?.(argument, context, value.options)); },
        async manage(load) {
          if (controller.signal.aborted || pending >= 8) return false;
          pending++;
          try { const resource = await load(controller.signal); if (!resource || typeof resource.dispose !== 'function') throw Error('Resource must provide dispose');
            own(() => resource.dispose()); return !controller.signal.aborted;
          } catch { if (!controller.signal.aborted) report(id, 'resource'); return false; } finally { pending--; }
        },
      });
      for (const name of Object.keys(hooks.commands ?? {})) commands.set(`${id}:${name}`, context);
      if (hooks.onPatch) for (const interest of value.interests) subscribe(interest, event => {
        const result: unknown = hooks.onPatch!(event, context);
        if (result && typeof (result as Promise<unknown>).then === 'function') { void Promise.resolve(result).catch(() => report(id, 'patch')); throw Error('onPatch must be synchronous; use manage for async work'); }
      });
      for (const rule of hooks.input ?? []) {
        const key = `${rule.type}:${rule.key}`, list = inputs.get(key) ?? [];
        list.push({ priority: rule.priority, run(input) { try { live(); return !!apply(() => rule.prepare(input, context, value.options)); } catch { report(id, 'input'); return false; } } });
        inputs.set(key, list);
      }
      const cleanup = hooks.onAttach?.(value.options, context);
      if (cleanup !== undefined) { if (typeof cleanup !== 'function') { void Promise.resolve(cleanup).then(late => { if (typeof late === 'function') (late as () => void)(); }).catch(() => report(id, 'attach')); error(id, 'onAttach', 'Return a synchronous disposer'); } own(cleanup); }
    }
    for (const list of inputs.values()) list.sort((a, b) => b.priority - a.priority);
  } catch (error) { dispose(); throw error; }
  return { dispose, diagnostics, hasInput: inputs.size > 0, runCommand(id: string, name: string, argument?: Json) {
    live(); const context = commands.get(`${id}:${name}`);
    if (!context) throw new ExtensionConfigurationError('unknown-command', id, name, 'Use a configured extension command');
    return context.command(name, argument);
  }, handle(input: ExtensionInputV1) {
    if (controller.signal.aborted || ports.blocked()) return false;
    return inputs.get(`${input.type}:${input.key}`)?.some(rule => rule.run(input)) ?? false;
  } };
}
