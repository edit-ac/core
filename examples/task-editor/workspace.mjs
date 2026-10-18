import { createEditor, contentModules, slashCommands, referenceSuggestions } from '@edit-ac/web';
import { markdownOptions } from './markdown.mjs';
import { localOptions } from './document.mjs';

// Prepared local product inputs, never remote upload or inferred document authority.
const imageBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII='), c => c.charCodeAt(0));
const expectedImageHash = '27ce4cd0859ffa137ec951b62df9ba8c19d37ac07d2c166a4ab6a2a3be1e9ae8';
const verifiedImage = crypto.subtle.digest('SHA-256',imageBytes).then(hash=>{if(Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')!==expectedImageHash)throw Error('Local image integrity failure');});
export const permissions = Object.freeze({ task: Object.freeze({ edit:true, rich:true, references:true, images:true }), comment: Object.freeze({ edit:true, rich:false, references:false, images:false }) });
const run = text => ({text, marks:[]});
const paragraph = text => ({attributes:{type:'paragraph'}, runs:[run(text)]});
const content = (tuple, text) => ({attributes:{type:'content', tuple}, runs:[run(text)]});
export const referenceTarget = Object.freeze({targetId:'ac://tasks/11111111-1111-4111-8111-111111111111',label:'Prepared local task'});
export const referenceCalls = [];
const resolveReference = request => {
  referenceCalls.push({query:request.query, requestId:request.requestId});
  return !request.signal.aborted && referenceTarget.label.toLowerCase().includes(request.query.toLowerCase()) ? [referenceTarget] : [];
};
const actions = [
  {id:'paragraph',label:'Text paragraph',prepare:()=>({type:'fragment',blocks:[paragraph('Task detail')]})},
  ...['unordered','ordered','checklist'].map(type=>({id:type,label:type==='checklist'?'Checklist':type==='ordered'?'Numbered list':'Bullet list',prepare:()=>({type:'fragment',blocks:[{...paragraph(type==='checklist'?'Task item':'List item'),containers:[{key:'product-list',style:type==='ordered'?{type,start:1}:{type}}],...(type==='checklist'?{checked:false}:{})}]})})),
  ...[true,false].map(checked=>({id:checked?'check':'uncheck',label:checked?'Check item':'Uncheck item',prepare:({node})=>({type:'editor',commands:[{type:'setChecked',owner:node,checked}]})})),
  {id:'table',label:'Task table',prepare:()=>({type:'fragment',blocks:[content(['module:editac.table',1,{alignments:['none'],rows:[[[['Task',[]]]],[[['Detail',[]]]]],source:'| Task |\n| --- |\n| Detail |'}],'Task table')]})},
  {id:'image',label:'Local image',prepare:()=>({type:'fragment',blocks:[content(['module:editac.asset',1,{identity:{host:'product-local',key:'pixel'},kind:'image',metadata:{alt:'Local sample pixel',caption:'',filename:'pixel.png',mediaType:'image/png',byteLength:imageBytes.length,sha256:expectedImageHash,width:2,height:2,durationMs:null},fallback:'Local sample pixel',source:'Local verified pixel'}],'Local sample pixel')]})},
];

export async function workspaceOptions(name, {profile=name, creation, readOnly=false}={}) {
  const permission = permissions[profile];
  if (!permission) throw Error('Unknown workspace profile');
  const options = await localOptions(name, undefined, creation);
  let imageURL, closed=false;
  const imageAssets = {async resolve(request,signal) {
    if (closed || !permission.images || signal.aborted || request.identity.host!=='product-local' || request.identity.key!=='pixel' || request.action!=='resolve-url' || request.byteLimit<imageBytes.length) return {state:'revoked'};
    await verifiedImage;
    if(closed || signal.aborted)return {state:'revoked'};
    imageURL ??= URL.createObjectURL(new Blob([imageBytes],{type:'image/png'}));
    return {state:'available',grant:{identity:request.identity,actions:['resolve-url','read']},resolution:{identity:request.identity,operationId:request.operationId,url:imageURL}};
  }};
  return {options: {...options,
    ...(permission.rich ? {...await markdownOptions(),content:contentModules({imageAssets}),slash:slashCommands(actions),references:referenceSuggestions(resolveReference)} : {preset:'minimal',typingShortcuts:false,plainPasteControl:false,commandAllowed:command=>['enter','break','backward','forward','undo','redo','replace'].includes(command)}),
    readOnly:readOnly || !permission.edit, commandControls:permission.rich, label:profile==='task'?'Task description':'Plain comment',
  }, permission, dispose(){closed=true;if(imageURL)URL.revokeObjectURL(imageURL);}};
}

export async function mountWorkspaceEditor(name, {root, status, creation, readOnly=false, recovery=[], onSave=()=>{}, onError=()=>{}, onHistory=()=>{}}) {
  const resources=await workspaceOptions(name,{creation,readOnly});
  const {options,permission}=resources;
  const editor=createEditor(root,options);
  let closed=false, generation=0, pending=false, lastError;
  const events = {save:[],error:[],history:[]};
  const report = error => {
    if(lastError!==error){events.error.push(error.message);onError(error);lastError=error;}
    status.dataset.state='error';
    status.textContent=`Local ${name} error: ${error.message}. Export recovery before closing.`;
  };
  const render = state => {
    if(state.error){report(state.error);return;}
    status.dataset.state=pending?'pending':state.ready?'local':'opening';
    status.textContent=pending?'Changes pending local save.':state.localCommitted?'Saved locally. Remote durability is not confirmed.':state.ready?'Ready locally. Remote durability is not confirmed.':'Opening local document…';
  };
  const unsubscribe = editor.subscribe(render);
  try {await editor.ready;} catch(error) {report(error);unsubscribe();await editor.destroy({policy:'report'});resources.dispose();throw error;}
  // The public lifecycle retains the last receipt while another update is pending.
  // Observe edits and use the public flush barrier before describing them as saved.
  const saveBarrier=async()=>{
    const captured=generation;
    try{await editor.flush({target:'local'});if(editor.state.error)throw editor.state.error;
      if(captured===generation)pending=false;
      render(editor.state);
      return {documentId:options.identity.documentId,localCommitted:editor.state.localCommitted};
    }catch(error){report(error);throw error;}
  };
  const unpatch=editor.subscribe({type:'updates'},()=>{
    generation++;pending=true;render(editor.state);
    queueMicrotask(()=>{if(!closed)void saveBarrier().catch(()=>{});});
  });
  render(editor.state);
  const historyListener = event => {if(event.key.toLowerCase()==='z'&&(event.metaKey||event.ctrlKey)){events.history.push(event.shiftKey?'redo':'undo');onHistory(events.history.at(-1));}};
  root.addEventListener('keydown',historyListener);
  return {editor, options, permission, events, recovery,
    async save(){const receipt=await saveBarrier();events.save.push(receipt);onSave(receipt);return receipt;},
    async close(){if(closed)return;closed=true;unsubscribe();unpatch();root.removeEventListener('keydown',historyListener);let result;try{result=await editor.destroy({policy:'flush'});}catch(error){report(error);result=await editor.destroy({policy:'report'});}finally{resources.dispose();}if(result.unsaved)recovery.push(result);return result;},
  };
}
