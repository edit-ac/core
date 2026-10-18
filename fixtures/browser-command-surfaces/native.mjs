import './native-session.mjs';
const fixture=window.inputFixture;
const events=[];
const root=document.querySelector('#projection');
let serial=0;
const point=(node,offset)=>({text:node?.textContent??null,offset});
for(const type of ['beforeinput','input','keydown','compositionstart','compositionend','contextmenu','focusin']){
 document.addEventListener(type,event=>{
  const selection=document.getSelection();
  events.push({activeElement:document.activeElement?.id,sequence:++serial,type,isTrusted:event.isTrusted,target:event.target?.id||event.target?.getAttribute?.('data-node-id')||event.target?.tagName,inputType:event.inputType??null,data:event.data??null,key:event.key??null,code:event.code??null,meta:event.metaKey??false,ctrl:event.ctrlKey??false,alt:event.altKey??false,shift:event.shiftKey??false,selection:selection?{anchor:point(selection.anchorNode,selection.anchorOffset),focus:point(selection.focusNode,selection.focusOffset)}:null,ranges:[...(event.getTargetRanges?.()??[])].map(r=>({start:point(r.startContainer,r.startOffset),end:point(r.endContainer,r.endOffset)}))});
  fetch('/native-evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({case:'native-event',at:new Date().toISOString(),event:events.at(-1)})}).catch(()=>{});
 },true);
}
document.querySelector('#case').value=new URL(location.href).searchParams.get('run')??'native-start';
document.documentElement.lang='en-US';root.lang='en-US';
await fixture.mount(new URL(location.href).searchParams.get('seed')??'mispeling sample');
document.querySelector('#status').textContent='Ready: real BrowserEditor, Session, WASM and IndexedDB';
async function capture(extra={}){
 const value={case:document.querySelector('#case').value,at:new Date().toISOString(),userAgent:navigator.userAgent,language:navigator.language,capabilities:{undoManager:typeof window.UndoManager,documentUndoManager:typeof document.undoManager,elementUndoManager:typeof root.undoManager},events:[...events],state:await Promise.race([fixture.state(),new Promise(resolve=>setTimeout(()=>resolve({error:'settle-timeout',dom:root.textContent,visible:fixture.engine.read().visible,history:fixture.engine.history({type:'state'})}),5000))]),host:document.querySelector('#host').value,...extra};
 document.querySelector('#evidence').textContent=JSON.stringify(value,null,2);
 const result=await fetch('/native-evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
 if(!result.ok)throw Error('Evidence recording failed');
 return value;
}
for(const [id,command] of [['bold','bold'],['undo','historyUndo'],['redo','historyRedo']]){
 const button=document.querySelector('#'+id);let target;
 button.addEventListener('pointerdown',event=>{target=fixture.surface.captureCommand(command);event.preventDefault();});
 button.addEventListener('click',async()=>{if(target){try{await target.execute();}finally{target.dispose();}}await capture({route:'visible-toolbar',command});});
}
document.querySelector('#snapshot').onclick=()=>capture();
document.querySelector('#reopen').onclick=async()=>{const before=await fixture.state();const reopened=await fixture.reopen();await fetch('/native-evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({case:'stored-document-recovery',at:new Date().toISOString(),before,reopened})});document.querySelector('#evidence').textContent=JSON.stringify({before:before.nodes,reopened},null,2);document.querySelector('#status').textContent='Stored document recovered; reload for a new session';};
document.querySelector('#second-editor').onclick=async()=>{await fixture.second();await capture({route:'second-editor-created'});};
window.nativeQualification={capture,events};
await capture();
