import { Spelling, type SpellingSuggestionV1, type SpellingCheckerV1 } from '@edit-ac/web';
/** Tiny, deliberately incomplete hand-authored fixture. No network/service account. */
export const preparedDictionary: Readonly<Record<string, readonly string[]>> = Object.freeze({ teh: Object.freeze(['the']), recieve: Object.freeze(['receive']), café: Object.freeze(['café']), wrng: Object.freeze(['right']) });
export const preparedChecker: SpellingCheckerV1 = Object.freeze({ locales: Object.freeze(['en']),
  check: (word: string) => Object.hasOwn(preparedDictionary, word) ? preparedDictionary[word]! : [] });
/** Accessible ephemeral suggestions live outside the editor's canonical DOM. */
export function presentSpelling(container: HTMLElement, suggestion: SpellingSuggestionV1) {
  const region = container.ownerDocument.createElement('div'); region.setAttribute('role', 'group');
  region.setAttribute('aria-label', `Spelling suggestions for ${suggestion.word}`);
  const label = container.ownerDocument.createElement('span'); label.textContent = suggestion.word; region.append(label);
  for (const replacement of suggestion.replacements) {
    const button = container.ownerDocument.createElement('button'); button.type = 'button';
    button.textContent = replacement; button.setAttribute('aria-label', `Replace ${suggestion.word} with ${replacement}`);
    button.addEventListener('click', () => suggestion.accept(replacement)); region.append(button);
  }
  const dismiss = container.ownerDocument.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => suggestion.dismiss()); region.append(dismiss); container.append(region);
  let disposed = false;
  return { dispose() { if (disposed) return; disposed = true; region.remove(); } };
}
export function preparedSpelling(container: HTMLElement) {
  return Spelling.configure({ mode: 'custom', locale: 'en', overlap: 'allow',
    checker: { async load() { return preparedChecker; }, present: suggestion => presentSpelling(container, suggestion) } });
}
