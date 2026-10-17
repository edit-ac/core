import {browserHarness} from './browser-harness.ts';
import {registerLargePasteCases} from './large-paste-cases.ts';
const {probe}=browserHarness('large-paste', 'fixtures/browser-input', { markdown: true, sourcePaths: ['tests/browser/large-paste-cases.ts'] });
registerLargePasteCases(probe);
