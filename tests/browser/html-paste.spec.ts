import {browserHarness} from './browser-harness.ts';
import {registerHtmlPasteCases} from './html-paste-cases.ts';
const {probe}=browserHarness('html-paste', 'fixtures/browser-input', {sourcePaths:['tests/browser/html-paste-cases.ts']});
registerHtmlPasteCases(probe);
