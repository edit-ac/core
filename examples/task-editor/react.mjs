import {createElement as h,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {EditorHost} from '@edit-ac/react';
import {workspaceOptions,referenceCalls} from './workspace.mjs';
import {downloadRecovery} from './recovery.mjs';

// Options and SDK handles stay outside React's document state. React owns only
// host lifetime; the public wrapper serializes flush/disposal and replacement.
export const slots=new Map(), lifecycle=[];
export {referenceCalls};
export let editor,route;
export const reactRoot=createRoot(document.querySelector('#workspace'));
const params=new URL(location.href).searchParams;
const readOnly=params.has('readonly');
const message=text=>{document.querySelector('#message').textContent=text;};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function render() {
  flushSync(()=>reactRoot.render(h(StrictMode,null,...[...slots.values()].filter(slot=>slot.mounted).map(slot=>h('section',{key:slot.name,'data-slot':slot.name},
    h('h2',null,slot.name==='document'?'Document body':slot.name==='task'?'Task description':'Comment'),
    h(EditorHost,{options:slot.options,readOnly:slot.readOnly,attributes:{id:slot.name==='task'?'editor':slot.name,'aria-label':slot.name},
      onReady(value){slot.editor=value;slot.events.ready++;lifecycle.push({name:slot.name,event:'ready'});slot.unsubscribe?.();const update=state=>{
        slot.state=state;const target=document.querySelector('#'+slot.name+'-status');
        if(target)target.textContent=state.error?'Local save failed. Export recovery before closing.':state.localCommitted?'Saved locally. Remote durability is not confirmed.':'Ready locally. Remote durability is not confirmed.';
      };slot.unsubscribe=value.subscribe(update);update(value.state);if(slot.name!=='comment')editor=value;slot.ready.resolve(value);},
      onError(error,value){if(value)slot.editor=value;slot.events.error.push(String(error));message('Unable to open or save. Existing data and recovery were preserved.');slot.ready.reject(error);},
      onDispose(result){slot.unsubscribe?.();slot.events.dispose++;lifecycle.push({name:slot.name,event:'disposed',unsaved:result.unsaved});if(result.unsaved){slot.recovery.push(result);message('Unsaved '+slot.name+' content retained. Export recovery before closing.');}slot.disposed.resolve(result);},
    }),
    h('button',{onClick:()=>void save(slot.name).catch(()=>{})},'Save '+slot.name+' locally'),
    h('button',{onClick:()=>exportRecovery(slot.name)},'Export '+slot.name+' recovery'),
    h('button',{onClick:()=>void dispose(slot.name)},'Close '+slot.name),
    h('p',{id:slot.name+'-status',role:'status'},'Opening local document…')
  )))));
}
async function prepare(name) {
  const profile=name==='comment'&&params.get('profiles')!=='equal'?'comment':'task';
  const resources=await workspaceOptions('react-'+name,{profile,readOnly,creation:{...(name==='task'?{databaseName:'example-react',key:'editac-example-react'}:{}),text:name==='comment'?'Add a comment':name==='document'?'Write the document':'Plan the task'}});
  resources.options.label=name==='document'?'Document body':name==='task'?'Task description':'Plain comment';
  const slot={name,...resources,readOnly,mounted:true,ready:deferred(),disposed:deferred(),recovery:slots.get(name)?.recovery??[],events:{ready:0,save:[],error:[],dispose:0}};
  // The public ready promise still rejects to the route caller, without an
  // unhandled rejection while another slot's preparation is in progress.
  void slot.ready.promise.catch(()=>{});slots.set(name,slot);return slot;
}
export async function save(name=route==='document'?'document':'task') {
  const slot=slots.get(name);try{await slot.ready.promise;await slot.editor.flush({target:'local'});const receipt={documentId:slot.options.identity.documentId,localCommitted:slot.editor.state.localCommitted};slot.events.save.push(receipt);return receipt;}
  catch(error){slot.events.error.push(String(error));message('Local save failed. Export recovery before closing.');throw error;}
}
export function recoveryFor(name) {const slot=slots.get(name);return [...slot.recovery,...(slot.editor?.state.ready?[slot.editor.recoveryExport()]:[])];}
export function exportRecovery(name) {downloadRecovery(recoveryFor(name));}
export async function dispose(name) {
  const slot=slots.get(name);if(!slot?.mounted)return;
  // A mounted slot is admitted before ordinary product disposal. The React
  // wrapper remains responsible for disposal while loading (covered separately).
  try{await slot.ready.promise;}catch{}
  slot.mounted=false;render();const report=await slot.disposed.promise;slot.dispose();return report;
}
let navigation=Promise.resolve();
export function navigate(next,{history=true}={}) {
  if(!['tasks','document'].includes(next))return Promise.reject(Error('Unknown product route'));
  navigation=navigation.catch(()=>{}).then(async()=>{
    for(const slot of slots.values())if(slot.mounted)await dispose(slot.name);
    route=next;const names=next==='document'?['document']:params.get('order')==='comment-first'?['comment','task']:['task','comment'];
    const prepared=[];for(const name of names)prepared.push(await prepare(name));render();
    await Promise.all(prepared.map(slot=>slot.ready.promise));
    if(history){const url=new URL(location.href);url.searchParams.set('route',next);window.history.pushState(null,'',url);}
    message(prepared.some(slot=>slot.recovery.length)?'Unsaved recovery retained. Export recovery before closing.':'Ready locally. Remote durability is not confirmed.');return prepared;
  });return navigation;
}
export async function setReadOnly(name,value) {const slot=slots.get(name);slot.readOnly=value;render();await new Promise(resolve=>requestAnimationFrame(resolve));}
export async function close() {await navigation;for(const slot of slots.values())if(slot.mounted)await dispose(slot.name);reactRoot.unmount();}
document.querySelector('#save').onclick=()=>void save().catch(()=>{});
document.querySelector('#export-recovery').onclick=()=>exportRecovery(route==='document'?'document':'task');
for(const link of document.querySelectorAll('[data-route]'))link.onclick=event=>{event.preventDefault();void navigate(link.dataset.route).catch(error=>message(error.message));};
window.addEventListener('popstate',()=>void navigate(new URL(location.href).searchParams.get('route')??'tasks',{history:false}).catch(error=>message(error.message)));
export const ready=navigate(params.get('route')??'tasks',{history:false});
void ready.catch(error=>message('Unable to open local document: '+error.message));
