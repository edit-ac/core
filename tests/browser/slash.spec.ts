import {browserHarness} from './browser-harness.ts';
import {registerSlashCases} from './slash-cases.ts';
const {probe}=browserHarness('slash','fixtures/browser-slash', { sourcePaths: ['tests/browser/slash-cases.ts'] });
registerSlashCases(probe);
