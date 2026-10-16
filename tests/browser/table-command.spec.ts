import {registerTableCommandCases} from './table-command-cases.ts';
import {browserHarness} from './browser-harness.ts';
const {probe}=browserHarness('table-command','fixtures/browser-content-modules',{markdown:true,assertSourcesUnchanged:true,sourcePaths:[
 'tests/browser/table-command-cases.ts','packages/web/src/modules/tables/clipboard.ts','packages/web/src/modules/content.ts','packages/web/src/modules/reorder.ts','packages/web/src/dom/render.ts','packages/web/src/dom/selection.ts','packages/web/src/surface.ts',
 'fixtures/browser-content-modules/session.mjs','fixtures/browser-content-modules/index.html','crates/editac-core/src/commands/table.rs','crates/editac-core/src/interchange.rs',
]});
registerTableCommandCases({probe});
