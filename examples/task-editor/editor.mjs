import {mountWorkspaceEditor} from './workspace.mjs';
import {retainRecovery,downloadRecovery} from './recovery.mjs';

export let editor, task, comment;
const recovery={task:[],comment:[]};
const slot = (name, id) => ({recovery:recovery[name],root:document.querySelector(id),status:document.querySelector(name==='task'?'#message':'#comment-message')});
const reportFor = (name,error) => {const status=document.querySelector(name==='task'?'#message':'#comment-message');status.dataset.state='error';status.textContent=`Unable to open or save ${name}: ${error.message}. Export recovery before closing.`;};
const report=error=>reportFor('task',error);
const readOnly = new URLSearchParams(location.search).has('readonly');
const readonlyPolicy={task:readOnly,comment:readOnly};
const creation={task:{databaseName:'standalone-task',key:'standalone-task-identity',text:'Plan the task'},comment:{text:'Add a comment'}};
const mount=async name=>{
  let handle;
  try{handle=await mountWorkspaceEditor(name,{...slot(name,name==='task'?'#editor':'#comment'),readOnly:readonlyPolicy[name],creation:creation[name]});}
  catch(error){reportFor(name,error);throw error;}
  if(name==='task'){task=handle;editor=handle.editor;}else comment=handle;
  document.querySelector(name==='task'?'#save':'#comment-save').disabled=false;
  document.querySelector(name==='task'?'#reopen':'#comment-reopen').disabled=false;
  return handle;
};
export const ready = (async()=>{
  // A failed identity must not prevent its independent sibling from opening.
  const results=await Promise.allSettled([mount('task'),mount('comment')]);
  const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  return {task,comment};
})();
export async function saveLocally(){return task.save();}
export async function reopenOffline(name='task'){
  if(!['task','comment'].includes(name))throw Error('Unknown local document');
  const current=name==='task'?task:comment;
  // Failed saves keep the live replica available. Closing is a separate user action.
  if(current && current.editor.state.phase!=='destroyed'){await current.save();await current.close();}
  return (await mount(name)).editor;
}
export function attachTaskSync(authorizedHostOptions){return editor.attachSync(authorizedHostOptions);}
export async function close(){const results=await Promise.all([task?.close(),comment?.close()]);for(const result of results)if(result)retainRecovery(result);return results[0];}
// Recovery is deliberately per document: exporting task never includes comment content.
document.querySelector('#export-recovery').onclick=()=>downloadRecovery([...recovery.task,...(editor && editor.state.phase!=='destroyed'?[editor.recoveryExport()]:[])]);
document.querySelector('#comment-export-recovery').onclick=()=>downloadRecovery([...recovery.comment,...(comment && comment.editor.state.phase!=='destroyed'?[comment.editor.recoveryExport()]:[])]);
document.querySelector('#save').onclick=()=>void saveLocally().catch(report);
document.querySelector('#reopen').onclick=()=>void reopenOffline().catch(report);
document.querySelector('#comment-save').onclick=()=>void comment.save().catch(error=>{document.querySelector('#comment-message').textContent=error.message;});
document.querySelector('#dispose-task').onclick=()=>void task.close().catch(report);
void ready.catch(()=>{});

document.querySelector('#comment-reopen').onclick=()=>void reopenOffline('comment').catch(error=>{document.querySelector('#comment-message').textContent=`Local comment error: ${error.message}. Export recovery before closing.`;});

document.querySelector('#prepare-offline').onclick=()=>void ready.then(async()=>{const {prepareOfflineShell}=await import('./offline.mjs');await prepareOfflineShell();}).catch(report);

export function revokeEditing(name){
  if(!['task','comment'].includes(name))throw Error('Unknown local document');
  readonlyPolicy[name]=true;(name==='task'?task:comment)?.editor.setReadOnly(true);
  document.querySelector(name==='task'?'#task-readonly':'#comment-readonly').disabled=true;
}
for(const name of ['task','comment']){const button=document.querySelector(`#${name}-readonly`);button.disabled=readOnly;button.onclick=()=>revokeEditing(name);}
