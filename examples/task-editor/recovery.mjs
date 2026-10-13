// Retain failed-save reports outside a framework component's lifetime.
export const recoveryReports = [];
export function retainRecovery(result) { if(result.unsaved) recoveryReports.push(result); }
export function downloadRecovery(content) {
  const json=JSON.stringify(content,(_key,value)=>value instanceof Uint8Array?{encoding:'bytes',data:Array.from(value)}:value,2);
  const url=URL.createObjectURL(new Blob([json],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='editac-recovery.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),0);
}
