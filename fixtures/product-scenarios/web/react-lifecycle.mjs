// Real installed EditorHost probe: asynchronous IndexedDB opening is still in
// flight when React removes one host. No DOM/editor/storage implementation fake.
import {createElement as h,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {EditorHost} from '@edit-ac/react';
import {workspaceOptions} from './workspace.mjs';
export async function loadingDisposal() {
  const canceled=await workspaceOptions('loading-task',{profile:'task'}),sibling=await workspaceOptions('loading-comment',{profile:'comment'});
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  let started=0,ready=0,disposed=0,survivor,resolveReady;const errors=[];
  const loaded=new Promise(resolve=>{resolveReady=resolve;});
  const open=indexedDB.open.bind(indexedDB);
  indexedDB.open=function(...args){if(args[0]===canceled.options.databaseName)started++;return open(...args);};
  const host=(key,options,onReady)=>h(EditorHost,{key,options,attributes:{'data-probe':key},onReady,onError:error=>errors.push(String(error)),onDispose(){if(key==='canceled')disposed++;}});
  try {
    flushSync(()=>root.render(h(StrictMode,null,host('canceled',canceled.options,()=>ready++),host('sibling',sibling.options,value=>{survivor=value;resolveReady();}))));
    const deadline=performance.now()+5000;
    // Yield microtasks only: IndexedDB completion requires a browser task.
    for(let i=0;i<100&&!started;i++)await Promise.resolve();
    if(!started)throw Error('Probe did not enter actual IndexedDB loading');
    flushSync(()=>root.render(h(StrictMode,null,host('sibling',sibling.options,value=>{survivor=value;resolveReady();}))));
    await loaded;
    while(disposed===0&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    survivor.root?.focus();
    const before=survivor.read().visible.map(n=>n.runs?.map(r=>r.text).join('')??'').join('');
    const report=await survivor.flush({target:'local'});
    return {started,ready,disposed,siblingReady:survivor.state.ready,before,report:!!report,errors};
  } finally {indexedDB.open=open;root.unmount();await new Promise(resolve=>setTimeout(resolve,20));canceled.dispose();sibling.dispose();container.remove();}
}
