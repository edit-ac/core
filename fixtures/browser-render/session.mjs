import { init } from '@edit-ac/core';
import { recoverLocalDocument } from '/web/entry.js';
import { CheckpointStorage } from '/web/storage/checkpoint.js';
import { DOMRenderer } from '/web/dom/render.js';
import { DOMSelection } from '/web/dom/selection.js';
import { TextInput } from '/web/input/text.js';
const identity = { documentId: '45678901-4567-4567-8567-45678901abcd', epoch: '56789012-5678-4678-8678-56789012abcd', schema: 'editac.registry.editor.v5', offsets: 'utf16', profile: 'editac.yrs-yjs.editor.v5', protocolVersion: 1, updateEncoding: 1 };
const root = document.querySelector('#projection');
let session, renderer, ids;
function execute(engine, request) { engine.commit(engine.prepare(request)); }
async function mount(readOnly = false) {
  const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
  const engine = runtime.createEngine({ profile: 'v5', documentId: identity.documentId, epoch: identity.epoch,
    nodes: ['alpha😀', 'Heading', 'first', 'second', 'nested', 'Checked', 'Quote', 'code <tag>', 'break', '', '<img src=x onerror=alert(1)>'].map(text => ({ text })) });
  ids = engine.read().visible.map(n => n.id);
  execute(engine, { kind: 'format', origin: 'render-fixture', marks: [], blocks: [{ targets: [ids[1]], attributes: { type: 'heading', level: 2 }, action: 'apply' }] });
  const a = engine.anchor(ids[0], 0, 'left'), b = engine.anchor(ids[0], 2, 'right');
  execute(engine, { kind: 'format', origin: 'render-fixture', blocks: [], marks: ['bold','italic','strike','underline'].map(mark => ({ range: {anchor:a,focus:b}, mark, action:'apply' })) });
  engine.releaseAnchor(a); engine.releaseAnchor(b);
  const ca=engine.anchor(ids[0],5,'left'),cb=engine.anchor(ids[0],7,'right');
  execute(engine,{kind:'format',origin:'render-fixture',blocks:[],marks:[{range:{anchor:ca,focus:cb},mark:'code',action:'apply'}]});engine.releaseAnchor(ca);engine.releaseAnchor(cb);
  const linkA = engine.anchor(ids[0],2,'left'), linkB = engine.anchor(ids[0],5,'right');
  execute(engine, { kind:'format',origin:'render-fixture',blocks:[],marks:[{ range:{anchor:linkA,focus:linkB},mark:'link',action:'apply',href:'https://example.org/path' }] });
  engine.releaseAnchor(linkA); engine.releaseAnchor(linkB);
  execute(engine, { kind:'editor',origin:'render-fixture',commands:[{type:'wrap',targets:[ids[2],ids[3],ids[4]],style:{type:'ordered',start:7}}] });
  execute(engine, { kind:'editor',origin:'render-fixture',commands:[{type:'indent',owner:ids[4]}] });
  execute(engine, { kind:'editor',origin:'render-fixture',commands:[{type:'wrap',targets:[ids[5]],style:{type:'checklist'}},{type:'setChecked',owner:ids[5],checked:true},{type:'wrap',targets:[ids[6]],style:{type:'quote'}},{type:'setCode',owner:ids[7],language:'js'}] });
  const br = engine.anchor(ids[8],5,'right');
  execute(engine, { kind:'editor',origin:'render-fixture',commands:[{type:'hardBreak',at:br},{type:'insertSeparator',beside:ids[9],side:'after'}] }); engine.releaseAnchor(br);
  const checkpoint = engine.checkpoint(); engine.dispose();
  const store = await CheckpointStorage.open(indexedDB,'browser-render');
  try { await store.publish(checkpoint,[]); } finally { store.close(); }
  session = await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName:'browser-render',identity,indexedDB,locks:navigator.locks});
  renderer = new DOMRenderer(root, session.writer.engine, {readOnly});
  document.querySelector('#status').textContent = 'Projection attached; DOM input is not enabled by this fixture';
  return {ids,snapshot:session.writer.engine.read()};
}
async function edit(id,offset,text) {
  const engine=session.writer.engine, at=engine.anchor(id,offset,'right');
  try { session.storage.commit({kind:'text',origin:'render-fixture',command:{type:'insert',at,text}}); await session.storage.flush({target:'local'}); }
  finally { engine.releaseAnchor(at); }
  return engine.read();
}
async function command(commands) { session.storage.commit({kind:'editor',origin:'render-fixture',commands}); await session.storage.flush({target:'local'}); return session.writer.engine.read(); }
async function format(id, level) { session.storage.commit({kind:'format',origin:'render-fixture',marks:[],blocks:[{targets:[id],attributes:{type:'heading',level},action:'apply'}]}); await session.storage.flush({target:'local'}); }
async function destroy() { renderer?.dispose(); await session?.storage.destroy({policy:'flush'}); }
window.renderFixture={DOMRenderer,DOMSelection,TextInput,mount,edit,command,format,destroy,get renderer(){return renderer},get engine(){return session.writer.engine},get ids(){return ids}};
