import { Spelling, type SpellingHostV1 } from '@edit-ac/web';
const checker: SpellingHostV1 = { async load() { return { locales: ['en'], check: () => ['the'] }; }, present() { return { dispose() {} }; } };
Spelling.configure();
Spelling.configure({ mode: 'off', autocorrection: 'on' });
Spelling.configure({ mode: 'custom', locale: 'en', overlap: 'allow', checker });
// @ts-expect-error Custom mode must supply an explicit checker.
Spelling.configure({ mode: 'custom', overlap: 'allow' });
// @ts-expect-error Unknown effective platform suppression requires an overlap choice.
Spelling.configure({ mode: 'custom', checker });
// @ts-expect-error Platform mode cannot activate a custom checker.
Spelling.configure({ mode: 'platform', checker });
// @ts-expect-error Independent autocorrection accepts only its declared values.
Spelling.configure({ mode: 'off', autocorrection: 'coupled' });
