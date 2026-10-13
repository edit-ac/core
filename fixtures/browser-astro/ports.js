import { init } from '@edit-ac/core';
import { installEditorHosts, mountEditorHost } from '@edit-ac/astro';
import { recoverLocalDocument } from '../../packages/web/dist/entry.js';
const facts = {ready:0,recoveries:0,disposed:0,live:0,peak:0,errors:[],reports:[]};
const editors = new Map();
const saveWaiters=new Set();
let runtime;
let releaseRecovery, slowSave=false, failSave=false, slowRecovery=false, failLoad=false;
export function installFixture(baseOptions) {
  const resolver = async(name) => {
    runtime=await init('/engine.wasm');
    return {...await baseOptions(name), recover:async options=>{
    facts.recoveries++;
    if (failLoad) throw Error('prepared load failure');
    if (slowRecovery) await new Promise(resolve=>{releaseRecovery=resolve;});
    const session=await recoverLocalDocument(options); facts.live++; facts.peak=Math.max(facts.peak,facts.live);
    // Exercise the real persistence queue; only its append transport is prepared.
    const append=session.storage.journal.append.bind(session.storage.journal);
    session.storage.journal.append=async update=>{
      if(slowSave) await new Promise(resolve=>{saveWaiters.add(resolve);});
      if(failSave) throw Error('prepared save failure');
      return append(update);
    };
    const destroy=session.storage.destroy.bind(session.storage);
    session.storage.destroy=async options=>{
      const result=await destroy(options);facts.live--;facts.disposed++;return result;
    };
    return session;
  }};};
  const events={onReady(editor,host){editors.set(host.dataset.editorName,editor);facts.ready++;},
    onError(error){facts.errors.push(error.message);},
    onDispose(result){
      let text=[];
      if(result.recovery){const engine=runtime.restoreEngine(result.recovery.checkpoint.identity,result.recovery.checkpoint);try{text=engine.read().visible.map(n=>n.runs.map(r=>r.text).join(''));}finally{engine.dispose();}}
      facts.reports.push({unsaved:result.unsaved,recovery:!!result.recovery,bytes:result.recovery?.checkpoint.bytes.length ?? 0,text});}};
  const stop=installEditorHosts(document,resolver,events);
  window.astroFixture={facts,editors,stop,
    editor(name='task'){return editors.get(name);},
    text(name='task'){return this.editor(name).read().visible.map(n=>n.runs.map(r=>r.text).join(''));},
    select(start,end=start,name='task'){
      const e=this.editor(name);e.root.focus();const block=e.read().visible.find(n=>n.kind==='block');
      const a=e.selection.toDOM({node:block.id,offset:start,bias:'right'}),b=e.selection.toDOM({node:block.id,offset:end,bias:'left'});
      document.getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset);e.selection.capture();
    },
    slowSave(){slowSave=true;}, releaseSave(){slowSave=false;for(const resolve of saveWaiters)resolve();saveWaiters.clear();},
    failSave(value=true){failSave=value;},failLoad(value=true){failLoad=value;},
    slowRecovery(){slowRecovery=true;},releaseRecovery(){slowRecovery=false;releaseRecovery?.();},
    async add(name){const host=document.createElement('edit-ac-editor');host.dataset.editorName=name;host.innerHTML='<div data-editor-surface></div>';document.body.append(host);return host;},
    setReadOnly(value){const host=document.querySelector('[data-editor-name="task"]');mountEditorHost(host,{},events).setReadOnly(value);},
    duplicate(){const host=document.querySelector('edit-ac-editor');return mountEditorHost(host,{},events)===mountEditorHost(host,{},events);},
    remove(name='task'){document.querySelector(`[data-editor-name="${name}"]`)?.remove();},
  };
}
