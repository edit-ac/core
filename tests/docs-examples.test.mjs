import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
process.env.EDITAC_DOCS_EXAMPLES='1';
process.env.EDITAC_PACKED_OUTPUT??='../evidence/sdk-docs/iteration3';
await import('./packed-consumers.test.mjs');
test('getting started links executable integrations and visible support limits',async()=>{
 const guide=await readFile('docs/integration.md','utf8');
 for(const term of ['@edit-ac/core','@edit-ac/web','@edit-ac/react','@edit-ac/astro','19.3.0','7.3.8','11.1.7','literal','localCommitted','remoteSettled','authentication','uploads','destroy','unsaved','native','migration']) assert.ok(guide.includes(term),term);
 assert.match(await readFile('README.md','utf8'),/docs\/integration.md/);
 for(const path of ['examples/task-editor/README.md','examples/astro/README.md','packages/astro/README.md'])assert.match(await readFile(path,'utf8'),/integration.md/);
});
