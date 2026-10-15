import { editingPackedCache } from './editing-packed-cache.mjs';
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { chromium, firefox, webkit } from 'playwright';
const engineName = process.env.EDITAC_RENDER_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[engineName];
if (!browserType) throw new Error(`Unknown render browser: ${engineName}`);
import { startFixtureServer } from './fixture-server.mjs';

const output = process.env.EDITAC_RENDER_OUTPUT ?? await mkdtemp(join(tmpdir(), 'editac-render-evidence-'));
await mkdir(output, { recursive: true });
const facts = { cases: [], processes: [], packed: {}, browser: {}, server: {}, cleanup: {} };
let consumer, server, browser, controller;
async function run(command, args, cwd, log) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
  await writeFile(join(output, log), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.equal(result.error, undefined, `${command}: see ${log}`);
  assert.equal(result.status, 0, `${command}: see ${log}`);
  return result.stdout;
}
before(async () => {
  consumer = await mkdtemp(join(tmpdir(), 'editac-render-consumer-'));
  const packed = await editingPackedCache('core',consumer) ?? JSON.parse(await run('npm', ['pack', '--workspace', '@edit-ac/core', '--json', '--pack-destination', consumer],
    process.cwd(), 'pack.log'))[0];
  const tarball = await readFile(join(consumer, packed.filename));
  await writeFile(join(output, packed.filename), tarball);
  facts.packed = { filename: packed.filename, bytes: tarball.length,
    sha256: createHash('sha256').update(tarball).digest('hex'), consumer,
    includesWasm: packed.files.some(file => file.path === 'dist/wasm/editac_wasm_bg.wasm') };
  assert.equal(facts.packed.includesWasm, true);
  await run('tar', ['-xzf', join(consumer, packed.filename), '-C', consumer], process.cwd(), 'unpack.log');
  server = await startFixtureServer({ fixtureDirectory: 'fixtures/browser-render', coreDirectory: join(consumer, 'package/dist') });
  facts.server = { ...server, close: undefined, launcher: 'node --test tests/browser/render.spec.ts',
    purpose: 'WEB-1.2 packed-core canonical entry', log: 'render.log' };
  controller = await browserType.launchServer({ headless: true });
  const child = controller.process();
  facts.processes.push({ pid: child.pid, launcher: child.spawnfile, workspace: process.cwd(),
    port: null, purpose: 'WEB-1.2 pinned Chromium', log: 'render.log' });
  browser = await browserType.connect(controller.wsEndpoint());
  facts.browser = { engine: engineName, version: browser.version(), playwright: '1.64.0',
    node: process.version, platform: process.platform, arch: process.arch };
});
after(async () => {
  try { if (browser) await browser.close(); }
  finally {
    try {
      if (controller) {
        await controller.close();
        facts.cleanup.browserExited = controller.process().exitCode !== null || controller.process().signalCode !== null;
        assert.equal(facts.cleanup.browserExited, true);
      }
    } finally {
      try {
        if (server) {
          await server.close();
          facts.cleanup.listenerRemoved = await new Promise(resolve => {
            const socket = createConnection(server.port, '127.0.0.1');
            socket.once('connect', () => { socket.destroy(); resolve(false); });
            socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
          });
          assert.equal(facts.cleanup.listenerRemoved, true);
        }
      } finally {
        if (consumer) await rm(consumer, { recursive: true, force: true });
        facts.cleanup.consumerRemoved = true;
        await writeFile(join(output, 'facts.json'), JSON.stringify(facts, null, 2));
      }
    }
  }
});
async function open(context) {
  const page = await context.newPage();
  await page.goto(server.url);
  await page.waitForFunction(() => !!window.renderFixture);
  return page;
}
async function withContext(name, action) {
  const context = await browser.newContext();
  const fact = { name, passed: false }; facts.cases.push(fact);
  try { await action(context, fact); fact.passed = true; }
  catch(error) { fact.error = String(error); throw error; }
  finally { await context.close(); }
}

for (const readOnly of [false, true]) test(`authored whitespace stays visible across block kinds and heading replacement (${readOnly ? 'read-only' : 'editable'})`, async () => withContext(`whitespace-${readOnly}`, async (context, fact) => {
  const page = await open(context);
  await page.evaluate(readOnly => window.renderFixture.mount(readOnly), readOnly);
  // Ordinary host CSS must not supply the editor's whitespace behavior.
  await page.addStyleTag({ content: '#projection { white-space: normal; font-family: monospace; }' });
  const result = await page.evaluate(async () => {
    const f = window.renderFixture;
    const cases = [[0, 'alpha😀'], [1, 'Heading'], [2, 'first'], [7, 'code <tag>']];
    for (const [index, text] of cases) {
      await f.edit(f.ids[index], 0, '  ');
      await f.edit(f.ids[index], text.length + 2, '  ');
    }
    await f.format(f.ids[1], 3);
    return cases.map(([index]) => {
      const id = f.ids[index], block = f.renderer.getBlock(id);
      const positions = f.renderer.positions(id);
      const width = offset => {
        const p = positions.find(p => offset >= p.start && offset < p.start + p.length);
        const range = document.createRange();
        range.setStart(p.node, offset - p.start); range.setEnd(p.node, offset - p.start + 1);
        return range.getBoundingClientRect().width;
      };
      const text = block.textContent;
      return { index, text, model: f.engine.read().visible.find(n => n.id === id).runs.map(r => r.text).join(''),
        tag: block.tagName, leading: [width(0), width(1)], trailing: [width(text.length - 2), width(text.length - 1)] };
    });
  });
  fact.whitespace = result;
  for (const [i, expected] of ['  alpha😀  ', '  Heading  ', '  first  ', '  code <tag>  '].entries()) {
    assert.equal(result[i].text, expected); assert.equal(result[i].model, expected);
    assert.ok([...result[i].leading, ...result[i].trailing].every(width => width > 0), `Spaces have visible advance in ${result[i].tag}`);
  }
  assert.equal(result[1].tag, 'H3');
}));


for (const commandKind of ['text', 'editor']) test(`one-character ${commandKind} patch preserves unrelated blocks and marked spans`, async () => withContext('incremental', async context => {
  const page = await open(context);
  const mounted = await page.evaluate(() => window.renderFixture.mount());
  const result = await page.evaluate(async ({ids,commandKind}) => {
    const f = window.renderFixture, r = f.renderer, root = r.root;
    const unrelated = r.getBlock(ids[1]), first = r.getBlock(ids[0]);
    const marked = first.querySelector('strong'), link = first.querySelector('a'), last = first.lastChild, text = last.firstChild;
    const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(unrelated); selection.removeAllRanges(); selection.addRange(range);
    const beforeSelection = selection.toString();
    const records=[]; const observer=new MutationObserver(mutations=>records.push(...mutations)); observer.observe(root,{childList:true,subtree:true,characterData:true,attributes:true});
    let snapshot;
    if (commandKind === 'text') snapshot = await f.edit(ids[0],7,'!');
    else { const at = f.engine.anchor(ids[0],7,'right'); try { snapshot = await f.command([{type:'insert',at,text:'!'}]); } finally { f.engine.releaseAnchor(at); } } await new Promise(resolve=>queueMicrotask(resolve)); observer.disconnect();
    return {text:first.textContent, same:[unrelated===r.getBlock(ids[1]),marked===first.querySelector('strong'),link===first.querySelector('a'),last===first.lastChild,text===last.firstChild],
      selection:selection.toString(),beforeSelection, mutations:records.map(m=>({type:m.type,old:m.oldValue})), model:snapshot.visible.find(n=>n.id===ids[0]).runs.map(r=>r.text).join(''),
      map:r.positions(ids[0]).map(p=>({start:p.start,length:p.length})), owner:r.getNodeId(text)};
  },{...mounted,commandKind});
  assert.equal(result.text,'alpha😀!'); assert.equal(result.model,result.text); assert.deepEqual(result.same,[true,true,true,true,true]);
  assert.equal(result.selection,result.beforeSelection); assert.equal(result.owner,mounted.ids[0]);
  assert.ok(result.mutations.length>0); assert.ok(result.mutations.every(m=>m.type==='characterData' || (commandKind === 'editor' && m.type==='attributes')));
  assert.equal(result.map.reduce((sum,p)=>sum+p.length,0),8);
}));

test('semantic headings marks nested lists checklist quote code and atoms', async () => withContext('semantics', async context => {
  const page=await open(context); await page.evaluate(()=>window.renderFixture.mount());
  const view=await page.evaluate(()=>{
    const f=window.renderFixture,root=f.renderer.root;
    return {editable:root.isContentEditable,editableRoots:root.querySelectorAll('[contenteditable="true"]').length,
      heading:root.querySelector('h2')?.textContent,marks:['strong','em','s','u','code'].map(tag=>root.querySelector(`p ${tag}`)?.textContent),
      href:root.querySelector('a')?.getAttribute('href'),ordered:root.querySelector('ol')?.getAttribute('start'),items:[...root.querySelectorAll('ol > li > p')].map(p=>p.textContent),
      nested:root.querySelector('ol ol li p')?.textContent,check:root.querySelector('[data-check-marker]')?.outerHTML,quote:root.querySelector('blockquote p')?.textContent,
      code:root.querySelector('pre')?.textContent,separator:root.querySelector('hr')?.contentEditable,
      break:f.renderer.getBlock(f.ids[8]).querySelectorAll('br').length,empty:f.renderer.getBlock(f.ids[9]).querySelector('br[data-placeholder]')!==null,
      mapped: f.engine.read().visible.every(n=>f.renderer.getBlock(n.id) && f.renderer.getNodeId(f.renderer.getBlock(n.id))===n.id)};
  });
  assert.equal(view.editable,true); assert.equal(view.editableRoots,0); assert.equal(view.heading,'Heading');
  assert.deepEqual(view.marks,['al','al','al','al','😀']);assert.equal(view.href,'https://example.org/path');
  assert.equal(view.ordered,'7');assert.ok(view.items.includes('first'));assert.ok(view.items.includes('second'));assert.equal(view.nested,'nested');
  assert.match(view.check,/contenteditable="false"/);assert.match(view.check,/aria-label="Checked"/);
  assert.equal(view.quote,'Quote');assert.equal(view.code,'code <tag>');assert.equal(view.separator,'false');assert.equal(view.break,1);assert.equal(view.empty,true);assert.equal(view.mapped,true);
}));

test('read-only engine projection displays hostile text literally', async () => withContext('read-only',async context=>{
  const page=await open(context);await page.evaluate(()=>window.renderFixture.mount(true));
  const view=await page.evaluate(()=>({editable:window.renderFixture.renderer.root.isContentEditable,text:window.renderFixture.renderer.getBlock(window.renderFixture.ids[10]).textContent,unsafe:document.querySelectorAll('#projection img,#projection script,[onerror]').length}));
  assert.equal(view.editable,false);assert.equal(view.text,'<img src=x onerror=alert(1)>');assert.equal(view.unsafe,0);
}));

test('untrusted projection attributes cannot create active markup or unsafe links',async()=>withContext('unsafe-attributes',async context=>{
  const page=await open(context);await page.evaluate(()=>window.renderFixture.mount(true));
  const view=await page.evaluate(async()=>{
    const {DOMRenderer}=await import('/web/dom/render.js');
    const root=document.createElement('div');document.body.append(root);
    const visible=['javascript:alert(1)','data:text/html,<script>alert(1)</script>','\tjavascript:alert(1)','https://example.org/safe'].map((link,i)=>({id:`unsafe-${i}`,kind:'block',parent:'@root',order:i,spans:[],editor:null,
      runs:[{text:'<script>literal</script>',attributes:{link,bold:true,onclick:'alert(1)',style:'position:fixed',unknown:'<img>'}}],blockAttributes:['unknown','<img>']}));
    const engine={read:()=>({revision:0,visible}),subscribe:()=>({dispose(){}})};
    const r=new DOMRenderer(root,engine,{readOnly:true});
    const result={tags:root.querySelectorAll('script,img,[onclick]').length,
      styles:[...root.querySelectorAll('[style]')].map(element=>({ whiteSpace: element.style.whiteSpace,
        unexpected: [...element.style].filter(key=>!['white-space','white-space-collapse','text-wrap-mode','white-space-trim'].includes(key)) })),
      links:[...root.querySelectorAll('a')].map(a=>a.href),texts:[...root.querySelectorAll('p')].map(p=>p.textContent),editable:root.isContentEditable};r.dispose();root.remove();return result;
  });
  assert.equal(view.tags,0);assert.deepEqual(view.links,['https://example.org/safe']);assert.deepEqual(view.texts,Array(4).fill('<script>literal</script>'));assert.equal(view.editable,false);
  assert.deepEqual(view.styles, Array(4).fill({ whiteSpace: 'break-spaces', unexpected: [] }), 'Only renderer-owned whitespace declarations are admitted; projection style is ignored');
}));

test('structural patches preserve node identity while changing headings and moving lists',async()=>withContext('structure',async context=>{
  const page=await open(context);await page.evaluate(()=>window.renderFixture.mount());
  const result=await page.evaluate(async()=>{
    const f=window.renderFixture,r=f.renderer, untouched=r.getBlock(f.ids[10]),item=r.getBlock(f.ids[3]);
    await f.format(f.ids[1],3);
    const heading=r.getBlock(f.ids[1]).tagName;
    await f.command([{type:'outdent',owner:f.ids[4]}]);
    const snapshot=f.engine.read();
    return {heading,same:untouched===r.getBlock(f.ids[10]),itemSame:item===r.getBlock(f.ids[3]),nestedItem:r.root.querySelector('ol ol li p')?.textContent ?? null,
      all:snapshot.visible.every(n=>r.positions(n.id).map(p=>p.node.nodeName==='BR'?'\n':p.node.textContent).join('')===n.runs.map(run=>run.text).join('') || n.kind!=='block' || n.blockAttributes[0]==='separator')};
  });
  assert.equal(result.heading,'H3');assert.equal(result.same,true);assert.equal(result.itemSame,true);assert.equal(result.nestedItem,null);assert.equal(result.all,true);
}));

test('hard-break UTF-16 maps and literal code newlines survive patches',async()=>withContext('offsets',async context=>{
  const page=await open(context);await page.evaluate(()=>window.renderFixture.mount());
  const result=await page.evaluate(async()=>{
    const f=window.renderFixture,r=f.renderer;
    const old=r.positions(f.ids[8]).map(p=>p.node);
    await f.edit(f.ids[7],4,'\n😀');await f.edit(f.ids[8],0,'😀');
    return {stableBreak:r.positions(f.ids[8]).every((p,i)=>p.node===old[i]),code:r.getBlock(f.ids[7]).textContent,codeBreaks:r.getBlock(f.ids[7]).querySelectorAll('br').length,
      positions:r.positions(f.ids[8]).map(p=>({type:p.node.nodeName,start:p.start,length:p.length})),text:r.getBlock(f.ids[8]).textContent};
  });
  assert.equal(result.code,'code\n😀 <tag>');assert.equal(result.codeBreaks,0);assert.equal(result.stableBreak,true);assert.equal(result.text,'😀break');
  assert.deepEqual(result.positions,[{type:'#text',start:0,length:7},{type:'BR',start:7,length:1},{type:'#text',start:8,length:0}]);
}));

test('renderer rebuilds disposable maps from authoritative recovered state',async()=>withContext('rebuild',async context=>{
  const page=await open(context);await page.evaluate(()=>window.renderFixture.mount());
  const result=await page.evaluate(async()=>{
    const f=window.renderFixture, {DOMRenderer}=await import('/web/dom/render.js'),r=f.renderer;
    await f.edit(f.ids[0],0,'R');const before=r.root.innerHTML;r.dispose();const rebuilt=new DOMRenderer(r.root,f.engine,{readOnly:true});
    const matches=before===rebuilt.root.innerHTML,mapped=rebuilt.getNodeId(rebuilt.getBlock(f.ids[0]).firstChild)===f.ids[0];rebuilt.dispose();return {matches,mapped};
  });assert.equal(result.matches,true);assert.equal(result.mapped,true);
}));
