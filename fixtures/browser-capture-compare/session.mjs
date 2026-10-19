// Only supported package entrypoints. Storage owns every committed edit.
import { init } from '@edit-ac/core';
import { WebHistoryStore, CheckpointStorage, openEditorStorage, prepareReview } from '@edit-ac/web';
const runtime = await init('/core/wasm/editac_wasm_bg.wasm');
const databaseName = 'public-capture-comparison';
let owner, store, access, old, subscription, patches=[];
async function disk() {
  const db = await new Promise((resolve,reject)=>{const r=indexedDB.open(databaseName);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try { const names=[...db.objectStoreNames].sort();const tx=db.transaction(names,'readonly');
    const values=await Promise.all(names.map(name=>new Promise((resolve,reject)=>{const r=tx.objectStore(name).getAll();r.onsuccess=()=>resolve([name,r.result]);r.onerror=()=>reject(r.error);})));return Object.fromEntries(values);
  } finally { db.close(); }
}
async function destroy(){subscription?.dispose();if(owner){await owner.destroy({policy:'flush'});owner=null;}window.fixtureDisposed=true;}
window.comparisonFixture={
  async mount(limits={}) {
    await destroy();await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(databaseName);r.onsuccess=resolve;r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('Database still owned'));});
    const seed=runtime.createEngine({profile:'v5',documentId:'95000000-0000-4000-8000-000000000001',epoch:'96000000-0000-4000-8000-000000000001',nodes:[{text:'before 😀'},{text:'independent'}]});
    const checkpoint=seed.checkpoint();seed.dispose();const disk=await CheckpointStorage.open(indexedDB,databaseName);try{await disk.publish(checkpoint,[]);}finally{disk.close();}
    owner=await openEditorStorage({assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName,identity:checkpoint.identity,indexedDB,locks:navigator.locks});
    patches=[];subscription=owner.engine.subscribe({type:'all'},p=>patches.push(p));owner.engine.history({type:'clear'});
    access={scope:{identity:owner.engine.read().identity,moduleProfile:'builtin-v5'},keyProfile:null};store=new WebHistoryStore(limits);
    old=await store.capture(owner.engine,access,'Before');window.fixtureDisposed=false;return old;
  },
  async change(){const e=owner.engine,id=e.read().visible[0].id;
    owner.commit({kind:'editor',origin:'public-capture-fixture',commands:[{type:'replaceAt',owner:id,from:0,to:6,text:'after'},{type:'markAt',owner:id,from:0,to:5,mark:'bold',action:'apply'},{type:'markAt',owner:id,from:0,to:5,mark:'link',action:'apply',href:'https://example.test/'}]});
    await owner.flush({target:'local'});return store.capture(e,access,'After');
  },
  async oracle(){await owner.flush({target:'local'});const e=owner.engine;return {snapshot:{...e.read(),changedNodes:[],touchedRanges:[]},checkpoint:e.checkpoint(),vector:e.stateVector(),update:e.encodeUpdate(),history:e.history({type:'state'}),generation:e.captureSemantic('builtin-v5').comparison.observedToken,patches:structuredClone(patches),usage:store.usage,list:store.list(access),disk:await disk()};},
  get engine(){return owner.engine;},get store(){return store;},get access(){return access;},get old(){return old;},
  capture(label){return store.capture(owner.engine,access,label);},
  compare(a,b,policy=access){return store.compare(owner.engine,a,b,policy);},
  prepare(model){return prepareReview({representation:'semantic',model});},destroy,
};
window.inputFixture={destroy};
