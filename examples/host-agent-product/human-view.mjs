import { recoverLocalDocument } from '/web/entry.js';
import { CheckpointStorage } from '/web/storage/checkpoint.js';
import { UpdateJournal } from '/web/storage/journal.js';
import { UpdateOutbox } from '/web/storage/outbox.js';
import { SyncSession } from '/web/sync/session.js';
import { DirectSyncAdapter } from '/web/sync/protocol.js';
import { DOMRenderer } from '/web/dom/render.js';
import { DOMSelection } from '/web/dom/selection.js';
import { TextInput } from '/web/input/text.js';

// Public storage owns the only local journal/history. This consumer retains no edits.
export async function mountHuman(root, config, channel, changed=()=>{}) {
  const name = `host-agent-product-${config.documentId}-${config.epoch}`;
  const seed = await channel('seed');
  if (seed.identity.documentId !== config.documentId || seed.identity.epoch !== config.epoch) throw Error('Seed scope mismatch');
  const identity = seed.identity;
  const exists = (await indexedDB.databases()).some(d=>d.name===name);
  if (!exists) {
    const disk = await CheckpointStorage.open(indexedDB,name);
    try { seed.bytes = new Uint8Array(seed.bytes); await disk.publish(seed,[]); }
    finally { disk.close(); }
  }
  const session = await recoverLocalDocument({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName:name,identity,indexedDB,locks:navigator.locks});
  const engine = session.writer.engine;
  let renderer,selection,input,outbox,sync,off,subscription,disposed=false;
  try {
    renderer = new DOMRenderer(root,engine); selection = new DOMSelection(renderer,engine);
    input = new TextInput(renderer,selection,engine,request=>session.storage.commit(request));
    outbox = await UpdateOutbox.open(indexedDB,name); sync = new SyncSession(engine,outbox);
    const adapter = new DirectSyncAdapter(engine,identity);
    const patches=[]; subscription=engine.subscribe({type:'all'},p=>{patches.push({origin:p.origin,operation:p.operation,update:!!p.update});if(patches.length>32)patches.shift();queueMicrotask(changed);});
    off=session.storage.subscribeCommitted(u=>sync.localCommitted(u.origin));
    // Explicit prepared loopback transport; no receipt/observe payload carries updates.
    const queuedFrames=[];
    sync.attach({send(frame){if(queuedFrames.length>=32)return false;queuedFrames.push(new Uint8Array(frame));return true;}},identity,true);
    const alive=()=>{if(disposed)throw Error('Human view disposed');};
    async function pull(){alive();const update=await channel('sync',{vector:[...engine.stateVector()]});alive();sync.receive(adapter.update({identity:update.identity,bytes:new Uint8Array(update.bytes)}));for(let i=0;i<8;i++){await session.storage.flush({target:'local'});await sync.pump(i);}await session.storage.flush({target:'local'});}
    async function publish(){alive();await session.storage.flush({target:'local'});const vector=await channel('vector');alive();await channel('peer',{writerId:engine.checkpoint().writerId,bytes:[...engine.encodeUpdate(new Uint8Array(vector)).bytes]});alive();queuedFrames.length=0;await pull();}
    async function evidence(){alive();await session.storage.flush({target:'local'});const journal=await UpdateJournal.open(indexedDB,name);try{return {identity:engine.checkpoint().identity,writerId:engine.checkpoint().writerId,history:engine.history({type:'state'}),texts:engine.read().visible.map(n=>n.runs.map(r=>r.text).join('')),ids:engine.read().visible.map(n=>n.id),journal:await journal.read(identity),pending:await outbox.pendingPage(identity,null,128,1048576),storage:session.storage.state,patches:[...patches]};}finally{journal.close();}}
    async function close(){if(disposed)return;disposed=true;input.dispose();selection.dispose();renderer.dispose();subscription.dispose();off();sync.dispose();outbox.close();try{await session.storage.destroy({policy:'flush'});}finally{root.replaceChildren();}}
    await pull();return {engine,selection,pull,publish,evidence,close};
  } catch(error){input?.dispose();selection?.dispose();renderer?.dispose();subscription?.dispose();off?.();sync?.dispose();outbox?.close();await session.storage.destroy({policy:'flush'});root.replaceChildren();throw error;}
}
