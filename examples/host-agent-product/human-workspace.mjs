import './read-workspace.mjs';
import { mountHuman } from './human-view.mjs';
const config=await(await fetch('/bridge.json')).json();
const section=document.querySelector('[aria-labelledby="human-heading"]');
section.innerHTML='<h2 id="human-heading">Human document view</h2><p>Prepared local editor. Human updates use collaboration, separately from read tools. Remote durability is unknown.</p><label for="human-scope">Human document scope</label><select id="human-scope"><option value="current">Current authorized fixture</option><option value="other">Other document (unavailable)</option></select><button id="human-open">Open / reopen editor</button><button id="human-pull">Receive shared updates</button><button id="human-publish">Publish human changes</button><button id="human-undo">Undo own edit</button><button id="human-close">Close editor</button><p id="human-state" role="status"></p><div id="human-editor" tabindex="0" role="textbox" aria-label="Human document editor" aria-multiline="true"></div>';
document.querySelector('#read').parentElement.querySelector('p').textContent='Read-only public host service beside the human editor. Tool notifications carry no collaboration content.';
const root=document.querySelector('#human-editor'),status=document.querySelector('#human-state');
let view,busy=false,ended=false;
const buttons=[...section.querySelectorAll('button,select')];
async function channel(action,fields={}){
  const response=await fetch('/human/channel',{method:'POST',headers:{'Content-Type':'application/json','X-Host-Fixture':config.token},body:JSON.stringify({action,documentId:config.documentId,epoch:config.epoch,...fields})});
  if(!response.ok)throw Error('Human channel unavailable; outcome unknown');return response.json();
}
async function close(){if(view){const old=view;view=undefined;await old.close();}root.replaceChildren();root.contentEditable='false';}
async function run(action){if(busy||ended)return;busy=true;buttons.forEach(b=>b.disabled=true);root.inert=true;try{await action();}catch{await close();status.textContent='Human view unavailable; outcome unknown. Local recovery retained.';}finally{busy=false;buttons.forEach(b=>b.disabled=false);root.inert=false;}}
async function open(){await close();if(document.querySelector('#human-scope').value!=='current'){status.textContent='Unavailable — no authorized owner for this document.';return;}view=await mountHuman(root,config,channel);if(ended){await close();return;}root.contentEditable='true';status.textContent='Human editor mounted. Local storage active; remote durability unknown.';}
document.querySelector('#human-open').onclick=()=>run(open);
document.querySelector('#human-pull').onclick=()=>run(async()=>{if(!view)throw Error();await view.pull();status.textContent='Shared updates received; local storage flushed. Remote durability unknown.';});
document.querySelector('#human-publish').onclick=()=>run(async()=>{if(!view)throw Error();await view.publish();status.textContent='Human update received by local owner. Remote durability unknown.';});
document.querySelector('#human-undo').onclick=()=>run(async()=>{if(!view)throw Error();view.engine.history({type:'undo'});await view.publish();status.textContent='Own history undo published; remote durability unknown.';});
document.querySelector('#human-close').onclick=()=>run(async()=>{await close();status.textContent='Human editor closed. Local recovery retained.';});
document.querySelector('#human-scope').onchange=()=>run(open);
window.addEventListener('pagehide',()=>{ended=true;void close();},{once:true});
// Read-only diagnostics for deterministic prepared workflow evidence; no mutation port.
window.humanWorkspace={evidence:()=>view?.evidence(),get mounted(){return !!view;}};
await run(open);
