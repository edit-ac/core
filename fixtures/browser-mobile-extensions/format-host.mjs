import { formatControls } from '/web/modules/formats.js';

// Prepared OS transports only. Production controls call the actual owning window
// APIs, and these fixtures retain every explicit request and exact payload.
export function installFormatPlatform(mode = 'absent') {
  const state = window.formatPlatform = {mode,calls:[],downloads:[],signals:[],writes:[],aborts:0,permissions:0,urls:new Set(),created:0,revoked:0};
  const denied = () => { throw new DOMException('Prepared refusal', mode === 'canceled' ? 'AbortError' : 'NotAllowedError'); };
  const record = async (action, file) => state.calls.push({action,filename:file.name,mediaType:file.type,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))});
  Object.defineProperty(navigator,'share',{configurable:true,value:mode==='absent'?undefined:async data=>{await record('share',data.files[0]);if(['denied','canceled'].includes(mode))denied();if(mode==='delayed')await new Promise(resolve=>{state.release=resolve;});}});
  Object.defineProperty(navigator,'canShare',{configurable:true,value:mode==='absent'?undefined:data=>{state.calls.push({action:'canShare',filename:data.files[0].name,mediaType:data.files[0].type});return mode!=='unsupported';}});
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:mode==='absent'?undefined:{async writeText(text){state.calls.push({action:'copy',text});if(['denied','canceled'].includes(mode))denied();}}});
  window.showOpenFilePicker=mode==='absent'?undefined:async()=>{state.calls.push({action:'pick'});if(['denied','canceled'].includes(mode))denied();if(mode==='delayed')await new Promise(resolve=>{state.release=resolve;});return [{async getFile(){state.calls.push({action:'getFile'});return new File(['picked 😀'],'prepared.txt',{type:'text/plain'});}}];};
  window.showSaveFilePicker=mode==='absent'?undefined:async options=>{state.calls.push({action:'save',options});if(['denied','canceled'].includes(mode))denied();if(mode==='delayed')await new Promise(resolve=>{state.release=resolve;});return {async createWritable(){state.calls.push({action:'createWritable'});return {async write(file){await record('write',file);if(mode==='write-failure')throw Error('Prepared write failure');if(mode==='delayed-write')await new Promise(resolve=>{state.release=resolve;});},async close(){state.calls.push({action:'close'});if(mode==='close-failure')throw Error('Prepared close failure');},async abort(){state.aborts++;}};}};};
  if(navigator.permissions)navigator.permissions.query=()=>{state.permissions++;throw Error('No real permission probes');};
  const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
  URL.createObjectURL=blob=>{const url=create(blob);state.urls.add(url);state.created++;return url;};
  URL.revokeObjectURL=url=>{if(state.urls.delete(url))state.revoked++;revoke(url);};
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){if(this.hasAttribute('download'))state.downloads.push({filename:this.download,url:this.href});return click.call(this);};
  return state;
}
export async function mountFormats(options = {}) {
  const f=window.inputFixture;
  window.formatState={signals:[],paused:!!options.paused};
  await f.mount({text:'alpha 😀',palette:options.markdown!==false,viewport:true,...options});
  const controls=window.formats=window.editor.enableFormatControls(formatControls(
    {maxBytes:options.maxBytes,schedule:async signal=>{window.formatState.signals.push(signal);if(window.formatState.paused)await new Promise(resolve=>{window.formatState.release=resolve;});}}));
  f.root.parentElement.before(controls.element); f.select(f.ids[0],2); await f.settle();
}
