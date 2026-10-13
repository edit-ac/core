import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.EDITAC_MARKDOWN_OUTPUT;
let temp, server, codec, engine, origin, installed;
const requests = [], packs = [], artifacts = [];
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.error, undefined, `${command}: ${result.error}`);
  assert.equal(result.status, 0, `${command}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
before(async () => {
  temp = await realpath(await mkdtemp(path.join(tmpdir(), 'editac-markdown-codec-')));
  installed = path.join(temp, 'consumer');
  await mkdir(installed);
  await writeFile(path.join(installed, 'package.json'), JSON.stringify({private:true,type:'module'}));
  for (const name of ['core', 'web', 'markdown']) {
    const pack = JSON.parse(run('npm', ['pack', '--workspace', `@edit-ac/${name}`, '--pack-destination', temp, '--json'], root))[0];
    packs.push({name, filename:pack.filename, integrity:pack.integrity, files:pack.files.map(f=>f.path)});
  }
  run('npm', ['install','--offline','--ignore-scripts','--no-audit','--no-fund', ...packs.map(p=>path.join(temp,p.filename))], installed);
  for (const name of ['core', 'web', 'markdown']) {
    const directory = path.join(installed, 'node_modules/@edit-ac', name);
    assert.equal(await realpath(directory), directory, 'installed package must not alias workspace source');
  }
  const parserDir = path.join(installed,'node_modules/@edit-ac/markdown');
  for (const file of ['dist/index.js','dist/wasm/editac_markdown_wasm.js','dist/wasm/editac_markdown_wasm_bg.wasm']) {
    const bytes = await readFile(path.join(parserDir,file));
    artifacts.push({file,sha256:createHash('sha256').update(bytes).digest('hex'),raw:bytes.length,gzip:gzipSync(bytes,{level:9,mtime:0}).length});
  }
  server = createServer(async (req,res) => {
    requests.push(req.url);
    try {
      const file = req.url === '/parser.wasm' ? path.join(parserDir,'dist/wasm/editac_markdown_wasm_bg.wasm') : req.url === '/engine.wasm' ? path.join(installed,'node_modules/@edit-ac/core/dist/wasm/editac_wasm_bg.wasm') : undefined;
      if (!file) {res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type','application/wasm');res.end(await readFile(file));
    } catch (error) {res.writeHead(500);res.end(String(error));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  // Installed ESM imports are safe in Node with no window/document. No init yet.
  const parser = await import(pathToFileURL(path.join(parserDir,'dist/index.js')).href);
  assert.deepEqual(requests,[],'package import must not fetch assets');
  await assert.rejects(parser.initMarkdown(''),TypeError);
  await assert.rejects(parser.initMarkdown(origin+'/missing.wasm'));
  const first = parser.initMarkdown(origin+'/parser.wasm');
  assert.equal(first,parser.initMarkdown(origin+'/parser.wasm'),'concurrent explicit loads share initialization');
  codec = await first;
  const core = await import(pathToFileURL(path.join(installed,'node_modules/@edit-ac/core/dist/index.js')).href);
  const runtime = await core.init(origin+'/engine.wasm');
  engine = runtime.createEngine({profile:'v5',documentId:'85000000-0000-4000-8000-000000000001',epoch:'86000000-0000-4000-8000-000000000001',nodes:[{text:'original'}]});
  engine.registerMarkdown(codec);
});
after(async () => {
  engine?.dispose();
  if (server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  if (evidence) {
    await mkdir(evidence,{recursive:true});
    await writeFile(path.join(evidence,'manifest.json'),JSON.stringify({scope:'stateless parser boundary only; not default profile admission',packs,artifacts,gzip:{level:9,mtime:0},requests},null,2)+'\n');
  }
  if (temp) await rm(temp,{recursive:true,force:true});
});

test('packed codec has only stateless WASM exports and required license/declarations', async () => {
  const file = path.join(installed,'node_modules/@edit-ac/markdown/dist/wasm/editac_markdown_wasm_bg.wasm');
  const exports = WebAssembly.Module.exports(await WebAssembly.compile(await readFile(file))).map(e=>e.name);
  assert(exports.includes('import_markdown') && exports.includes('export_markdown') && exports.includes('markdown_equivalent'));
  assert(!exports.some(n=>/engine_|fixture_|created_document|anchor|checkpoint|history|apply_update/.test(n)));
  assert(packs[2].files.includes('LICENSE') && packs[2].files.includes('THIRD-PARTY-NOTICES.txt') && packs[2].files.includes('dist/index.d.ts'));
  assert.equal(requests.filter(r=>r==='/parser.wasm').length,1);
});

test('installed declarations compile without source/workspace aliases', async () => {
  await writeFile(path.join(installed,'consumer.ts'), `import {initMarkdown,type MarkdownCodec} from '@edit-ac/markdown';\nconst codec:Promise<MarkdownCodec> = initMarkdown('https://host/parser.wasm');\nvoid codec;\n`);
  run(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','consumer.ts'],installed);
});

test('compiled stateless parser preserves qualified grammar and Unicode round trips', () => {
  for (const source of ['# **😀**\n\n[late][r]\n\n[r]: https://example.com','> quote\n\n- [x] task\n- item','```rust\nlet x = 1;\n```','a e\u0301 👩\u200d💻 אב']) {
    const prepared = codec.importMarkdown(source);
    assert.equal(prepared.source, source);
    assert(prepared.blocks.length > 0);
    const exported = codec.exportMarkdown(prepared.blocks);
    assert.deepEqual(exported,engine.exportMarkdown(prepared.blocks));
    assert.deepEqual(codec.exportMarkdown(codec.importMarkdown(exported.markdown).blocks),exported);
  }
});

test('optional images/tables/callouts retain registered content and disabled source diagnostics', () => {
  for (const source of ['![alt](https://example.com/image)','|a|b|\n|-|-|\n|c|d|','> [!NOTE]\n> text','<script>unsafe</script>']) {
    for (const options of [{},{images:true,tables:true,callouts:true}]) {
      const prepared = codec.importMarkdown(source,options);
      assert.equal(prepared.source, source);
      const exported=codec.exportMarkdown(prepared.blocks);
      if (prepared.blocks.some(b=>b.attributes?.type==='content')) {
        assert.deepEqual(codec.exportMarkdown(codec.importMarkdown(exported.markdown,options).blocks),exported);
      } else if (prepared.diagnostics.length) {
        assert(prepared.diagnostics.length > 0);
        assert.equal(prepared.source,source);
      }
      if (!source.startsWith('<script>') && !options.images) assert(prepared.diagnostics.length > 0);
      if (!source.startsWith('<script>') && options.images) assert(prepared.blocks.some(b=>b.attributes?.type==='content')); 
    }
  }
});

test('safe international links and unsafe source diagnostics preserve historical behavior', () => {
  const safe = codec.importMarkdown('[safe](https://例え.テスト/a)');
  assert(safe.blocks.some(b=>b.runs.some(r=>r.marks.some(m=>m.mark==='link' && m.href.startsWith('https://xn--')))));
  const unsafe=codec.importMarkdown('[unsafe](javascript:alert(1))');
  assert(unsafe.diagnostics.length > 0);
  assert(!unsafe.blocks.some(b=>b.runs.some(r=>r.marks.some(m=>m.mark==='link'))));
  const blocks = [{attributes:{type:'paragraph'},runs:[{text:'unsafe',marks:[{mark:'link',href:'javascript:alert(1)'}]}]}];
  assert.throws(()=>codec.exportMarkdown(blocks),e=>e.code==='EngineRejected');
});

test('bounded errors and ordered extension hooks preserve recovery data', () => {
  assert.throws(()=>codec.importMarkdown('x'.repeat(1_048_577)),e=>e.code==='EngineRejected');
  assert.throws(()=>codec.importMarkdown('x',{extensions:[{name:'duplicate'},{name:'duplicate'}]}),e=>e.code==='InvalidInput');
  assert.throws(()=>codec.importMarkdown('x',{extensions:[{name:'bad',prepare:()=>[{attributes:{type:'heading',level:7},runs:[]}]}]}),e=>e.code==='EngineRejected');
  const blocks = codec.importMarkdown('original').blocks;
  const exported = codec.exportMarkdown(blocks,{extensions:[{name:'different',serialize:()=> 'changed'}]});
  assert.equal(exported.diagnostics[0].code,'extension-unrepresentable');
  assert.deepEqual(exported.recovery,blocks);
});

test('codec preserves strict JSON admission and never invokes accessors/toJSON', () => {
  let touched = false;
  const custom = {toJSON(){touched=true;return [];}}, accessor = [];
  Object.defineProperty(accessor,'0',{enumerable:true,get(){touched=true;return {};}});
  accessor.length=1;
  for (const value of [custom,accessor,[undefined],[NaN],Array(1)]) assert.throws(()=>codec.exportMarkdown(value),e=>e.code==='InvalidInput');
  assert.equal(touched,false);
});

test('codec owns no document and prepared fragments use existing anchor/plan/history boundary', () => {
  engine.read(); // Drain initial projection bookkeeping before comparing reads.
  const before = engine.read(), checkpoint = engine.checkpoint(), history = engine.history({type:'state'});
  const prepared = codec.importMarkdown('**replacement 😀**');
  codec.exportMarkdown(prepared.blocks);
  assert.deepEqual(engine.read(),before);
  assert.deepEqual(engine.checkpoint(),checkpoint);
  assert.deepEqual(engine.history({type:'state'}),history);
  const node = before.visible[0], anchor = engine.anchor(node.id,0,'right'), focus = engine.anchor(node.id,8,'left');
  try {
    const request={kind:'fragment',origin:'markdown-codec-test',range:{anchor,focus},blocks:prepared.blocks};
    assert.equal(engine.can(request),true);
    engine.commit(engine.prepare(request));
    assert.equal(engine.read().identity.documentId,before.identity.documentId);
    assert(engine.read().visible.some(n=>n.runs.some(r=>r.text.includes('replacement'))));
    engine.history({type:'undo'});
    assert(engine.read().visible.some(n=>n.runs.some(r=>r.text.includes('original'))));
  } finally { engine.releaseAnchor(anchor);engine.releaseAnchor(focus); }
});

 test('default production engine omits parser exports and registration is per-document/disposable', async () => {
  const file=path.join(installed,'node_modules/@edit-ac/core/dist/wasm/editac_wasm_bg.wasm');
  const names=WebAssembly.Module.exports(await WebAssembly.compile(await readFile(file))).map(e=>e.name);
  assert(!names.some(n=>/markdown|fixture|created_document/.test(n)));
  const core=await import(pathToFileURL(path.join(installed,'node_modules/@edit-ac/core/dist/index.js')).href);
  const runtime=await core.init(origin+'/engine.wasm');
  const local=runtime.createEngine({profile:'v5',documentId:'85000000-0000-4000-8000-000000000002',epoch:'86000000-0000-4000-8000-000000000002',nodes:[{text:'untouched'}]});
  try {
    local.read(); const before=local.checkpoint();
    assert.equal(local.markdownAvailable,false);
    for(const action of [()=>local.importMarkdown('# original'),()=>local.exportMarkdown([])]) assert.throws(action,e=>e.code==='CapabilityUnavailable' && e.message==='markdown-codec-unavailable');
    assert.deepEqual(local.checkpoint(),before);
    assert.throws(()=>local.registerMarkdown({}),e=>e.code==='InvalidInput');
    const first=local.registerMarkdown(codec); assert.equal(first.active,true);
    assert.equal(local.markdownAvailable,true); assert.equal(local.importMarkdown('# title').blocks[0].attributes.type,'heading');
    assert.throws(()=>local.registerMarkdown(codec),e=>e.code==='InvalidInput');
    assert.deepEqual(local.checkpoint(),before);
    first.dispose();first.dispose();assert.equal(first.active,false);
    const second=local.registerMarkdown(codec);first.dispose();assert.equal(second.active,true);
    local.dispose();assert.equal(second.active,false);assert.equal(local.markdownAvailable,false);second.dispose();
    assert.throws(()=>local.importMarkdown('x'),e=>e.code==='Disposed');
    assert.throws(()=>local.registerMarkdown(codec),e=>e.code==='Disposed');
  } finally {local.dispose();}
 });
