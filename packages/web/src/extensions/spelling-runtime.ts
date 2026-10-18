import type { SpellingCheckerV1, SpellingHostV1 } from './spelling.js';
import type { PatternResolutionV1 } from './matching.js';
/** Optional checker/presentation execution, imported only by explicit custom input. */
export async function resolveSpelling(word: string, locale: string | undefined, signal: AbortSignal,
  host: SpellingHostV1, load: () => Promise<SpellingCheckerV1>): Promise<PatternResolutionV1> {
  if (!locale) { host.diagnostic?.('unknown-locale'); return { status: 'unavailable' }; }
  let replacements: readonly string[];
  try {
    const checker = await load();
    if (signal.aborted) return { status: 'unavailable' };
    if (!Array.isArray(checker.locales) || checker.locales.length > 32 || !checker.locales.includes(locale)) { host.diagnostic?.('unavailable-locale'); return { status: 'unavailable' }; }
    replacements = await checker.check(word, locale, signal);
  } catch { host.diagnostic?.('unavailable-checker'); return { status: 'unavailable' }; }
  if (signal.aborted) return { status: 'unavailable' };
  if (!Array.isArray(replacements) || replacements.length > 5 || replacements.some(text => typeof text !== 'string' || !text || text.length > 256 || /[\u0000-\u001f\u007f]/u.test(text))) {
    host.diagnostic?.('invalid-result'); return { status: 'unavailable' };
  }
  if (!replacements.length) return { status: 'missing' };
  const choices = Object.freeze([...new Set(replacements)]);
  return new Promise(resolve => {
    let done = false, presentation: { dispose(): void } | undefined;
    const finish = (result: PatternResolutionV1) => {
      if (done) return; done = true; signal.removeEventListener('abort', cancel);
      try { presentation?.dispose(); } finally { resolve(result); }
    };
    const cancel = () => finish({ status: 'unavailable' });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    try {
      presentation = host.present(Object.freeze({ word, replacements: choices,
        accept(replacement: string) { if (choices.includes(replacement)) finish({ status: 'replacement', replacement }); }, dismiss: cancel }));
      if (!presentation || typeof presentation.dispose !== 'function') throw Error('Invalid presenter');
      if (done) presentation.dispose();
    } catch { cancel(); }
  });
}
