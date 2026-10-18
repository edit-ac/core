import {mountWorkspaceEditor} from './workspace.mjs';
import {retainRecovery,downloadRecovery} from './recovery.mjs';

export let editor, task, comment;
const recovery={task:[],comment:[]};
const slot = (name, id) => ({recovery:recovery[name],root:document.querySelector(id),status:document.querySelector(name==='task'?'#message':'#comment-message')});
const report = error => {document.querySelector('#message').textContent=`Unable to open or save task: ${error.message}`;};
const readOnly = new URLSearchParams(location.search).has('readonly');
export const ready = (async()=>{
  // Retain the original standalone identity and namespace, including failed creation intent.
  task = await mountWorkspaceEditor('task',{...slot('task','#editor'),readOnly,creation:{databaseName:'standalone-task',key:'standalone-task-identity',text:'Plan the task'}});
  editor=task.editor;
  comment = await mountWorkspaceEditor('comment',{...slot('comment','#comment'),readOnly,creation:{text:'Add a comment'}});
  document.querySelector('#save').disabled=document.querySelector('#reopen').disabled=false;
  document.querySelector('#comment-save').disabled=false;
  return {task,comment};
})();
export async function saveLocally(){return task.save();}
export async function reopenOffline(){await task.close();task=await mountWorkspaceEditor('task',{...slot('task','#editor'),readOnly,creation:{databaseName:'standalone-task',key:'standalone-task-identity'}});editor=task.editor;return editor;}
export function attachTaskSync(authorizedHostOptions){return editor.attachSync(authorizedHostOptions);}
export async function close(){const results=await Promise.all([task?.close(),comment?.close()]);for(const result of results)if(result)retainRecovery(result);return results[0];}
// Recovery is deliberately per document: exporting task never includes comment content.
document.querySelector('#export-recovery').onclick=()=>downloadRecovery([...recovery.task,...(editor?.state.ready?[editor.recoveryExport()]:[])]);
document.querySelector('#comment-export-recovery').onclick=()=>downloadRecovery([...recovery.comment,...(comment?.editor.state.ready?[comment.editor.recoveryExport()]:[])]);
document.querySelector('#save').onclick=()=>void saveLocally().catch(report);
document.querySelector('#reopen').onclick=()=>void reopenOffline().catch(report);
document.querySelector('#comment-save').onclick=()=>void comment.save().catch(error=>{document.querySelector('#comment-message').textContent=error.message;});
document.querySelector('#dispose-task').onclick=()=>void task.close().catch(report);
void ready.catch(report);
