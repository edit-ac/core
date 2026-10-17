import {browserHarness} from './browser-harness.ts';
import {registerClipboardCases} from './clipboard-cases.ts';
const {probe}=browserHarness('clipboard', 'fixtures/browser-input', { sourcePaths: ['tests/browser/clipboard-cases.ts', 'fixtures/browser-input/session.mjs', 'benchmarks/fixtures.mjs'] });
registerClipboardCases(probe);
