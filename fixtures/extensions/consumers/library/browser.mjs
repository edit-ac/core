import * as extensions from '@edit-ac/core/extensions';
import {init} from '@edit-ac/core';
import {initMarkdown} from '@edit-ac/markdown';
import {CheckpointStorage, createEditor, taskPreset} from '@edit-ac/web';
import {ExtensionCommandSession, ExtensionTransferRegistry, canonicalSemanticJson} from '@edit-ac/web/modules';
import {openTutorial} from './tutorial.mjs';
import {assert, runContractChecks} from './profile-conformance.mjs';

const corpus=await (await fetch('/clipboard.json')).json();
const profiles=await (await fetch('/profiles.json')).json();
const definitions=await (await fetch('/definitions.json')).json();
const runtime=await init('/engine.wasm'), markdown=await initMarkdown('/markdown.wasm');
assert(extensions.ExtensionTransferRegistry===ExtensionTransferRegistry,'one owning transfer registry');
assert(extensions.EXTENSION_API_VERSION===1,'public API version');
const registry=new ExtensionTransferRegistry(corpus.descriptors.map(descriptor=>({descriptor,
  ...(!['editac.disabled-image','editac.rich-table'].includes(descriptor.type)?{codec:{prepare:e=>e.payload}}:{})})));
const mime='application/x-edit-ac-extension+json';
let editor,options,prepared,activation,sequence=0;
const semantic=()=>editor.read().visible.filter(n=>n.kind==='block'&&!(n.blockAttributes?.[0]==='paragraph'&&n.runs.every(r=>r.text==='')))
  .map(n=>({blockAttributes:n.blockAttributes,runs:n.runs,editor:n.editor?{containerAttributes:n.editor.containerAttributes,checked:n.editor.checked,number:n.editor.number}:null}));
async function close(){activation?.dispose();activation?.dispose();if(editor){await editor.destroy({policy:'flush'});editor=undefined;}}
function selectStart(){
  const root=document.querySelector('#editor');root.focus();
  const block=root.querySelector('[data-node-id]');assert(block,'rendered target');
  const range=document.createRange();range.selectNodeContents(block);range.collapse(true);
  const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}
window.library={
  ids:corpus.cases.map(c=>c.id),
  async contracts(){return runContractChecks(extensions,profiles);},
  async open(id){
    await close();const fixture=corpus.cases.find(c=>c.id===id);assert(fixture,'known fixture');
    const suffix=String(++sequence).padStart(12,'0');
    // Prepare against the seed before attachment. Only inert candidate blocks cross
    // into the clipboard codec; the actual editor repeats owning target admission.
    const engine=runtime.createEngine({profile:'v5',documentId:`91000000-0000-4000-8000-${suffix}`,epoch:`92000000-0000-4000-8000-${suffix}`,nodes:[{text:''}]});
    const identity=engine.read().identity,checkpoint=engine.checkpoint();
    try {engine.registerMarkdown(markdown);prepared=registry.prepare(engine,fixture.envelope);assert(prepared.mode===fixture.mode,'transfer mode');}
    finally {engine.dispose();}
    const databaseName='extension-library-'+sequence,store=await CheckpointStorage.open(indexedDB,databaseName);
    try {await store.publish(checkpoint,[]);} finally {store.close();}
    const profile=extensions.prepareExtensionProfile(extensions.FIRST_PARTY_PROFILES.core,extensions.FIRST_PARTY_FEATURES,{schema:identity.schema,capabilities:[]});
    activation=new extensions.ExtensionProfileActivation(profile);let loads=0;
    await activation.activate(Object.fromEntries(extensions.FIRST_PARTY_FEATURES.map(f=>[f.id,async()=>{loads++;throw Error('disabled optional loader');}])));
    assert(loads===0&&activation.resourceCount===0,'core profile evaluates no optional features');
    options={...taskPreset({plainPasteControl:false}),identity,databaseName,assetUrl:'/engine.wasm',indexedDB,locks:navigator.locks,
      clipboardCodecs:[{mime,prepare:raw=>{assert(raw===extensions.exportExtensionTransfer(fixture.envelope),'immutable prepared offer');return prepared.blocks;}}]};
    editor=createEditor(document.querySelector('#editor'),options);await editor.ready;selectStart();
    const before=JSON.stringify(editor.read());editor.setReadOnly(true);
    assert(editor.paste({getData:type=>type===mime?extensions.exportExtensionTransfer(fixture.envelope):''}).disposition==='rejected','read-only paste');
    assert(JSON.stringify(editor.read())===before,'read-only atomicity');editor.setReadOnly(false);selectStart();
    const result=editor.paste({getData:type=>type===mime?extensions.exportExtensionTransfer(fixture.envelope):''});
    assert(result.disposition==='committed','actual clipboard/storage mutation: '+JSON.stringify(result));
    await editor.flush({target:'local'});
    const saved=semantic();assert(saved.length>0,'nonempty admitted semantics');
    if(fixture.mode==='fallback')assert(canonicalSemanticJson(saved[0].blockAttributes)===canonicalSemanticJson(['module:editac.inert-extension',1,fixture.envelope]),'exact inert envelope');
    if(id==='table-v2-mixed-cell')assert(canonicalSemanticJson(saved[0].blockAttributes)===canonicalSemanticJson(fixture.envelope.payload[0].attributes.tuple),'exact table v2 metadata/formatting');
    return {id,mode:prepared.mode,diagnostics:prepared.diagnostics,saved,resources:activation.resourceCount};
  },
  read:semantic,
  async reopen(){const saved=semantic();await editor.destroy({policy:'flush'});editor=createEditor(document.querySelector('#editor'),options);await editor.ready;
    assert(JSON.stringify(semantic())===JSON.stringify(saved),'actual IndexedDB journal/checkpoint reopen');return semantic();},
  async tutorial(){
    await close();const identity=await (await fetch('/fixtures/identity.json')).json(),databaseName='library-tutorial';
    const engine=runtime.restoreEngine(identity,{identity,initialized:true,writerId:11,bytes:new Uint8Array(await (await fetch('/fixtures/custom-checkpoint.bin')).arrayBuffer())});
    const store=await CheckpointStorage.open(indexedDB,databaseName);try{await store.publish(engine.checkpoint(),[]);}finally{engine.dispose();store.close();}
    const host={identity,databaseName,assetUrl:'/engine.wasm',indexedDB,locks:navigator.locks,definitions};
    const root=document.querySelector('#editor'),tutorial=await openTutorial(root,{...host,presenters:true});
    try {
      const custom=()=>tutorial.editor.read().visible.find(n=>n.id==='n:11:1').runs;
      const expected=custom();assert(tutorial.stats.mounted>0,'custom public presenter mounts');
      const owner=tutorial.editor.read().visible.find(n=>n.kind==='block'&&n.id!=='n:11:1').id;
      assert((await tutorial.insertNote(markdown,owner,'[note] Packed library 😀')).status==='committed','public codec/command integration');
      assert(JSON.stringify(custom())===JSON.stringify(expected),'custom data retained after source edit elsewhere');
      await tutorial.dispose();await tutorial.dispose();assert(tutorial.stats.mounted===tutorial.stats.disposed,'presenter disposal');
      const fallback=await openTutorial(root,{...host,presenters:false});
      try{assert(JSON.stringify(fallback.editor.read().visible.find(n=>n.id==='n:11:1').runs)===JSON.stringify(expected),'absent presenter reopen preserves opaque data');assert(fallback.stats.mounted===0,'disabled presenter creates no resources');}
      finally{await fallback.dispose();}
      return {passed:true,mounted:tutorial.stats.mounted,disposed:tutorial.stats.disposed};
    } finally {await tutorial.dispose();}
  },
  async stale(){
    const owner=editor.read().visible.find(n=>n.kind==='block').id;
    const anchor=editor.anchor(owner,0,'right');let resolve;
    const commands=new ExtensionCommandSession({get active(){return editor.state.ready;},revision(){const s=editor.read();return JSON.stringify([s.identity,s.revision]);},can:r=>editor.can(r),commit:r=>editor.commit(r)});
    try{const before=JSON.stringify(semantic()),pending=commands.run(()=>new Promise(done=>resolve=done));commands.dispose();commands.dispose();
      resolve({kind:'editor',origin:'library:stale',commands:[{type:'replaceAt',owner,from:0,to:0,text:'late'}]});
      assert((await pending).status==='cancelled','disposed async result');assert(JSON.stringify(semantic())===before,'no late semantic mutation');return true;
    }finally{commands.dispose();editor.releaseAnchor(anchor);}
  },
  async finish(){await close();assert(!editor&&activation.resourceCount===0,'consumer teardown');return true;}
};
