import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.EDITAC_EXTENSION_EXPORTS_OUTPUT;
const fixtures = process.env.EDITAC_MODULE_REGISTRY_FIXTURES;
const facts = { packs: [], checks: [], artifacts: [] };
let temp, consumer;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, args, cwd, label) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  facts.checks.push({ label, command, args, exit: result.status });
  if (output) {
    // Preserve complete child output, including failures, outside the hot handoff.
    const log = join(output, label + '.log');
    return writeFile(log, result.stdout + result.stderr).then(() => {
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.status, 0, `${label}: see ${log}`);
      return result.stdout;
    });
  }
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `${label}: ${result.stderr}\n${result.stdout}`);
  return Promise.resolve(result.stdout);
}
const prelude = `
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {init} from '@edit-ac/core';
import {ModuleRegistry,ModuleContractError,EXTENSION_API_VERSION} from '@edit-ac/core/extensions';
import * as web from '@edit-ac/web/modules';
const corpus=JSON.parse(await readFile('registration.json','utf8'));
const registry=()=>{const r=new ModuleRegistry();for(const d of corpus.definitions)r.register(d);return r;};
const code=c=>e=>e instanceof ModuleContractError&&e.code===c;
`;
async function check(label, body, prefix = prelude) {
  const filename = label + '.mjs';
  await writeFile(join(consumer, filename), prefix + body);
  if (output) await copyFile(join(consumer, filename), join(output, filename));
  await run(process.execPath, [filename], consumer, label);
}
before(async () => {
  assert(fixtures, 'run the Rust module_registry fixtures first with EDITAC_MODULE_REGISTRY_FIXTURES');
  if (output) await mkdir(output, { recursive: true });
  temp = await realpath(await mkdtemp(join(tmpdir(), 'editac-extension-exports-')));
  consumer = join(temp, 'consumer'); await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  for (const name of ['core', 'web', 'markdown']) {
    const pack = JSON.parse(await run('npm', ['pack', '--workspace', `@edit-ac/${name}`, '--pack-destination', temp, '--json'], root, 'pack-' + name))[0];
    facts.packs.push({ name, filename: pack.filename, integrity: pack.integrity, files: pack.files.map(f => f.path) });
    if (output) await copyFile(join(temp, pack.filename), join(output, pack.filename));
  }
  await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...facts.packs.map(p => join(temp, p.filename))], consumer, 'install');
  for (const name of ['core', 'web', 'markdown']) {
    const directory = join(consumer, 'node_modules/@edit-ac', name);
    assert.equal(await realpath(directory), directory, 'packed consumer must not alias workspace sources');
  }
  await copyFile(join(root, 'fixtures/modules/registration.json'), join(consumer, 'registration.json'));
  for (const file of ['custom-checkpoint.bin', 'identity.json']) await copyFile(join(fixtures, file), join(consumer, file));
  for (const file of ['packages/core/dist/wasm/editac_wasm_bg.wasm', 'packages/markdown/dist/wasm/editac_markdown_wasm_bg.wasm', 'fixtures/modules/registration.json']) {
    facts.artifacts.push({ path: file, sha256: hash(await readFile(join(root, file))) });
  }
});
after(async () => {
  try { if (output) await writeFile(join(output, 'consumer-receipt.json'), JSON.stringify(facts, null, 2) + '\n'); }
  finally { if (temp) await rm(temp, { recursive: true, force: true }); }
});

test('packed public extension imports are inert and share one registry identity', async () => {
  await check('inert-imports', `
    const core=await import('@edit-ac/core/extensions');
    const web=await import('@edit-ac/web/modules');
    const compat=await import('@edit-ac/web');
    assert.equal(core.EXTENSION_API_VERSION,1);
    assert.equal(core.ModuleRegistry,web.ModuleRegistry);
    assert.equal(core.ModuleRegistry,compat.ModuleRegistry);
    assert.equal(core.ModuleContractError,web.ModuleContractError);
    assert.equal(typeof web.ModuleRuntime,'function');
    await assert.rejects(import('@edit-ac/core/src/extensions/registry.js'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
    await assert.rejects(import('@edit-ac/web/dist/modules/registry.js'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
  `, `import assert from 'node:assert/strict';
    const forbidden=()=>{throw Error('implicit activation');};
    for(const key of ['window','document','navigator','indexedDB'])Object.defineProperty(globalThis,key,{get:forbidden});
    globalThis.fetch=forbidden;
    globalThis.WebAssembly=new Proxy(WebAssembly,{get:forbidden});
  `);
});
test('packed declarations expose versioned descriptor command codec and presenter types', async () => {
  const source = `import {EXTENSION_API_VERSION,ModuleRegistry,type ModuleDefinitionV1,type ExtensionCommandV1,type MarkdownCodecV1,type MarkdownExtensionV1} from '@edit-ac/core/extensions';
import {ModuleRuntime,type ModuleRenderer,type PrepareRequest} from '@edit-ac/web/modules';
const version:1=EXTENSION_API_VERSION;
const definition:ModuleDefinitionV1={type:'demo.mark',version:1,kind:'mark',attributes:{},content:{type:'text',maxUtf16:64},fallback:{type:'text',source:'content'}};
new ModuleRegistry().register(definition).freeze();
const command:ExtensionCommandV1={type:'setStyle',container:'x',style:{type:'quote'}};
declare const codec:MarkdownCodecV1;declare const hook:MarkdownExtensionV1;declare const renderer:ModuleRenderer;declare const request:PrepareRequest;
void [version,command,codec,hook,renderer,request,ModuleRuntime];
`;
  await writeFile(join(consumer, 'consumer.ts'), source);
  if (output) await writeFile(join(output, 'consumer.ts'), source);
  await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], consumer, 'declarations');
});
test('packed invalid duplicate and incompatible registrations fail atomically', async () => {
  await check('atomic-registration', `
    const r=registry();
    for(const {definition} of corpus.invalidDefinitions)assert.throws(()=>r.register(definition),code('invalid-definition'));
    assert.throws(()=>r.register(corpus.definitions[0]),code('duplicate'));
    assert.throws(()=>r.register({...corpus.definitions[0],version:2}),code('incompatible'));
    assert.throws(()=>r.register({...corpus.definitions[0],type:'demo.rejected'},{tag:'script'}),code('invalid-definition'));
    assert.equal(r.size,2);r.freeze();
    assert.equal(r.resolve('module:demo.highlight',[1,{label:'original'}],'x').definition.version,1);
    assert.throws(()=>r.register(corpus.definitions[1]),code('frozen'));
  `);
});
test('packed descriptors reject callbacks and getters without executing them', async () => {
  await check('inert-descriptors', `
    const r=registry();let calls=0;
    const getter={...corpus.definitions[0],type:'demo.getter'};
    Object.defineProperty(getter,'attributes',{enumerable:true,get(){calls++;throw Error('executed');}});
    assert.throws(()=>r.register(getter),code('invalid-definition'));
    assert.throws(()=>r.register({...corpus.definitions[0],type:'demo.callback',renderer:()=>calls++}),code('invalid-definition'));
    assert.equal(calls,0);assert.equal(r.size,2);
  `);
});
test('packed mark and atom registrations preserve genuine custom data on unchanged production WASM', async () => {
  await check('production-custom-data', `
    const bytes=await readFile('node_modules/@edit-ac/core/dist/wasm/editac_wasm_bg.wasm');
    const runtime=await init('data:application/wasm;base64,'+bytes.toString('base64'));
    const identity=JSON.parse(await readFile('identity.json','utf8'));
    const checkpoint={identity,initialized:true,writerId:11,bytes:new Uint8Array(await readFile('custom-checkpoint.bin'))};
    const engine=runtime.restoreEngine(identity,checkpoint);
    try {
      const before=engine.checkpoint();const snapshot=engine.read();const r=registry().freeze();
      r.validate(snapshot.visible);r.validate(snapshot.recovery);
      const runs=snapshot.visible.find(n=>n.id==='n:11:1').runs;
      assert.deepEqual(runs,corpus.runs);
      assert.equal(r.resolve('module:demo.highlight',runs[0].attributes['module:demo.highlight'],runs[0].text).definition.kind,'mark');
      assert.equal(r.resolve('module:demo.badge',runs[1].attributes['module:demo.badge'],runs[1].text).definition.kind,'inline-atom');
      assert.deepEqual(engine.checkpoint(),before,'registration never mutates the document');
      const restored=runtime.restoreEngine(identity,before);
      try{assert.deepEqual(restored.read().visible,snapshot.visible);}finally{restored.dispose();}
    }finally{engine.dispose();engine.dispose();}
  `);
});
test('packed public codec and command contracts use existing prepare commit boundary', async () => {
  await check('public-codec-command', `
    const {initMarkdown}=await import('@edit-ac/markdown');
    const codec=await initMarkdown('data:application/wasm;base64,'+(await readFile('node_modules/@edit-ac/markdown/dist/wasm/editac_markdown_wasm_bg.wasm')).toString('base64'));
    const runtime=await init('data:application/wasm;base64,'+(await readFile('node_modules/@edit-ac/core/dist/wasm/editac_wasm_bg.wasm')).toString('base64'));
    const engine=runtime.createEngine({profile:'v5',documentId:'91000000-0000-4000-8000-000000000001',epoch:'92000000-0000-4000-8000-000000000001',nodes:[{text:'old'}]});
    try{
      const registration=engine.registerMarkdown(codec);
      const prepared=engine.importMarkdown('**new**');
      assert.match(engine.exportMarkdown(prepared.blocks).markdown,/\\*\\*new\\*\\*/);
      const node=engine.read().visible[0];const anchor=engine.anchor(node.id,0,'left'),focus=engine.anchor(node.id,3,'right');
      const before=engine.checkpoint();
      const plan=engine.prepare({kind:'fragment',origin:'local:extension',range:{anchor,focus},blocks:prepared.blocks});
      assert.deepEqual(engine.checkpoint(),before);
      engine.commit(plan);assert.equal(engine.read().visible[0].runs[0].text,'new');
      assert.equal(engine.read().visible[0].runs[0].attributes.bold,true);
      engine.releaseAnchor(anchor);engine.releaseAnchor(focus);registration.dispose();registration.dispose();
      assert.equal(engine.markdownAvailable,false);
    }finally{engine.dispose();}
  `);
});
