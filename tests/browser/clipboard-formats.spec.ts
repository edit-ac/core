import {browserHarness} from './browser-harness.ts';
import {registerClipboardFormatsCases} from './clipboard-formats-cases.ts';
const {probe}=browserHarness('clipboard-formats', 'fixtures/browser-input', { markdown: true, sourcePaths: ['tests/browser/clipboard-formats-cases.ts'] });
registerClipboardFormatsCases(probe);
