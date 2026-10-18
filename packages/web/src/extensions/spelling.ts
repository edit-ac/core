import { Extension } from './authoring.js';
import { ExtensionConfigurationError } from './contract.js';
import type { ConfiguredExtensionV1, PlatformPreferencesV1 } from './contract.js';
import type { PatternControllerV1, PatternOptionsV1 } from './matching.js';
export interface SpellingCheckerV1 {
  readonly locales: readonly string[];
  check(word: string, locale: string, signal: AbortSignal): Promise<readonly string[]> | readonly string[];
}
export interface SpellingSuggestionV1 {
  readonly word: string; readonly replacements: readonly string[];
  /** Single use, current target only; never the visible caret. */
  accept(replacement: string): void;
  dismiss(): void;
}
export interface SpellingHostV1 {
  /** Explicit trusted host callback; no built-in provider or credentials. */
  load(signal: AbortSignal): Promise<SpellingCheckerV1>;
  /** Ephemeral accessible presentation outside canonical editor text. */
  present(suggestion: SpellingSuggestionV1): { dispose(): void };
  diagnostic?(status: 'unknown-locale' | 'unavailable-locale' | 'unavailable-checker' | 'invalid-result'): void;
  status?: PatternOptionsV1['onStatus'];
  attached?(controller: PatternControllerV1): void;
}
export type SpellingOptionsV1 = Readonly<{
  autocorrection?: 'inherit' | 'on' | 'off'; locale?: string;
}> & (Readonly<{ mode?: 'platform' | 'off'; checker?: never; overlap?: never; timeoutMs?: never }> |
  Readonly<{ mode: 'custom'; checker: SpellingHostV1; overlap: 'allow'; timeoutMs?: number }>);
import { custom } from './spelling-metadata.js';
/** One public configuration path. Merge the returned extensions with other selections. */
export const Spelling = Object.freeze({ configure(options: SpellingOptionsV1 = {}) {
  const mode = options.mode ?? 'platform';
  if (!['platform','off','custom'].includes(mode) || (options.autocorrection !== undefined && !['inherit','on','off'].includes(options.autocorrection)) ||
      (options.locale !== undefined && (typeof options.locale !== 'string' || options.locale.length > 64 || !/^[A-Za-z0-9-]+$/.test(options.locale))))
    throw Error('Invalid spelling policy/locale');
  if (mode !== 'custom' && options.checker) throw Error('Checker requires explicit custom mode');
  const platform = Object.freeze({ spellcheck: mode, ...(options.autocorrection ? { autocorrection: options.autocorrection } : {}), ...(options.locale !== undefined ? { locale: options.locale } : {}) });
  if (mode !== 'custom') return Object.freeze({ platform, extensions: Object.freeze([] as ConfiguredExtensionV1[]) });
  if (!options.checker || typeof options.checker.load !== 'function' || typeof options.checker.present !== 'function' || options.overlap !== 'allow')
    throw Error('Custom spelling requires a checker, accessible presenter and explicit overlap: allow; effective platform suppression is unknown');
  const supplied = options.checker;
  if (['diagnostic','status','attached'].some(key => supplied[key as 'diagnostic' | 'status' | 'attached'] !== undefined && typeof supplied[key as 'diagnostic' | 'status' | 'attached'] !== 'function')) throw Error('Invalid spelling host callback');
  const host: SpellingHostV1 = Object.freeze({ load: supplied.load.bind(supplied), present: supplied.present.bind(supplied),
    ...(supplied.diagnostic ? { diagnostic: supplied.diagnostic.bind(supplied) } : {}),
    ...(supplied.status ? { status: supplied.status.bind(supplied) } : {}),
    ...(supplied.attached ? { attached: supplied.attached.bind(supplied) } : {}) });
  const locale = options.locale, timeout = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw Error('Invalid spelling deadline');
  const value = Extension.create<Record<string, never>>({ apiVersion: 1,
    feature: { id: 'spelling.custom', version: 1, schemas: ['editac.registry.editor.v5'], capabilities: ['commands'], permissions: [], requires: [], conflicts: [], bindings: [], qualification: 'qualified', owner: 'spelling',
      ownership: { focus: 'host', nestedControls: 'exclude', drag: 'host-text-or-block', composition: 'exclude', selection: 'prepared-result', history: 'one-intent', presenters: [], cancellation: 'abort-and-revision', teardown: 'idempotent' } },
    semantics: { kind: 'behavior' }, defaults: {}, validateOptions: () => true, loading: 'required-input', interests: [],
    onAttach(_, context) {
      let checker: Promise<SpellingCheckerV1> | undefined;
      const controller = context.match({ application: 'replacement', contextUtf16: 128, maxMatches: 8, concurrency: 4, queue: 4, cacheEntries: 0, timeoutMs: timeout, paste: 'match',
        permission: () => ({ principal: 'local', tenant: 'host', authority: 'spelling', revision: '1', lookup: true, apply: true }),
        literal: patch => patch.origin.includes(':literal'),
        match(window) {
          const found = [];
          for (const match of window.text.matchAll(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu)) {
            const start = match.index!, text = match[0], end = start + text.length;
            if ((start === 0 && window.start !== 0) || end === window.text.length || text.length > 64 ||
                /[\p{L}\p{M}\p{N}_-]/u.test(window.text.slice(Math.max(0,start-1),start)) ||
                /[\p{L}\p{M}\p{N}_-]/u.test(window.text.slice(end,end+1))) continue;
            found.push({ start, end, text }); if (found.length === 8) break;
          }
          return found;
        },
        async resolve(request) {
          const runtime = await import('./spelling-runtime.js');
          if (request.signal.aborted) return { status: 'unavailable' };
          return runtime.resolveSpelling(request.text, locale, request.signal, host,
            () => checker ??= host.load(context.signal));
        }, ...(host.status ? { onStatus: host.status } : {}),
      });
      host.attached?.(controller);
    },
  }).configure();
  custom.add(value);
  return Object.freeze({ platform, extensions: Object.freeze([value]) });
} });
