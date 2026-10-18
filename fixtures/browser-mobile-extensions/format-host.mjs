import { formatControls } from '/web/modules/formats.js';

// Prepared OS transports only. Production controls call the actual owning window
// APIs, and these fixtures retain every explicit request and exact payload.
export function installFormatPlatform(mode = 'absent') {
  const state = window.formatPlatform = {mode,calls:[],downloads:[],signals:[],writes:[],aborts:0,permissions:0,urls:new Set(),created:0,revoked:0};
  const denied = () => { throw new DOMException('Prepared refusal', mode === 'canceled' ? 'AbortError' : 'NotAllowedError'); };
  if (mode === 'inactive') Object.defineProperty(navigator,'userActivation',{configurable:true,value:{isActive:false,hasBeenActive:false}});
  const record = async (action, file) => state.calls.push({action,filename:file.name,mediaType:file.type,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))});
  Object.defineProperty(navigator,'share',{configurable:true,value:mode==='absent'?undefined:async data=>{await record('share',data.files[0]);if(['denied','canceled'].includes(mode))denied();if(mode==='delayed')await new Promise(resolve=>{state.release=resolve;});}});
  Object.defineProperty(navigator,'canShare',{configurable:true,value:mode==='absent'?undefined:data=>{state.calls.push({action:'canShare',filename:data.files[0].name,mediaType:data.files[0].type});return mode!=='unsupported';}});
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:mode==='absent'?undefined:{async writeText(text){state.calls.push({action:'copy',text});if(['denied','canceled'].includes(mode))denied();if(mode==='delayed')await new Promise(resolve=>{state.release=resolve;});}}});
  window.showOpenFilePicker=mode==='absent'?undefined:async()=>{state.calls.push({action:'pick'});if(['denied','canceled'].includes(mode))denied();if(mode==='delayed')await new Promise(resolve=>{state.release=resolve;});return [{async getFile(){state.calls.push({action:'getFile'});return new File(['picked 😀'],'prepared.txt',{type:'text/plain'});}}];};
  window.showSaveFilePicker=mode==='absent'?undefined:async options=>{state.calls.push({action:'save',options});if(['denied','canceled'].includes(mode))denied();if(mode==='delayed')await new Promise(resolve=>{state.release=resolve;});return {async createWritable(){state.calls.push({action:'createWritable'});if(mode==='delayed-writer')await new Promise(resolve=>{state.release=resolve;});return {async write(file){await record('write',file);if(mode==='write-failure')throw Error('Prepared write failure');if(['delayed-write','delayed-write-failure'].includes(mode))await new Promise(resolve=>{state.release=resolve;});if(mode==='delayed-write-failure')throw Error('Prepared late write failure');},async close(){state.calls.push({action:'close'});if(mode==='close-failure')throw Error('Prepared close failure');},async abort(){state.aborts++;}};}};};
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
  window.formatState={signals:[],paused:!!options.paused,profileLoads:0,clientLoads:0,clientCalls:[],clientDisposals:0,authorityCalls:[],assetCalls:[],assetMode:options.assets};
  await f.mount({text:'alpha 😀',palette:options.markdown!==false,viewport:true,...options});
  const controls=window.formats=window.editor.enableFormatControls(formatControls(
    {maxBytes:options.maxBytes,
     ...(options.assets?{authorizeImport:async(file,signal)=>{
       const state=window.formatState;state.authorityCalls.push(file.name);state.signals.push(signal);
       if(state.assetMode==='delayed-authority')await new Promise(resolve=>{state.releaseAuthority=resolve;});
       const response=await fetch('/fixture/import-authority.json',{signal}),data=await response.json();
       const grant={identity:{host:'mobile-format-fixture',key:'original-png'},actions:['ingest','read','cancel','release-reference']};
       const sourceGrant={identity:{host:'local-recovery',key:'selected-package'},actions:grant.actions};
       state.grant=grant;state.sourceGrant=sourceGrant;
       return {sourceGrant,importGrants:[{...grant,sha256:state.assetMode==='bad-hash'?Array(32).fill(0):data.sha256}],
         host:{async authorize(request,signal){state.assetCalls.push({action:'authorize',request});state.signals.push(signal);return {identity:request.identity,actions:state.assetMode==='denied'?[]:grant.actions};},
           async execute(reference,request,bytes,signal){state.assetCalls.push({action:'execute',reference,request,bytes:bytes?Array.from(bytes):null});state.signals.push(signal);if(state.assetMode==='delayed-ingest')await new Promise(resolve=>{state.releaseIngest=resolve;});return null;}}};
     }}:{}),schedule:async signal=>{window.formatState.signals.push(signal);if(window.formatState.paused)await new Promise(resolve=>{window.formatState.release=resolve;});},
     ...(options.client?{loadClient:async signal=>{
       const state=window.formatState;state.clientLoads++;
       if(options.client==='paused')await new Promise(resolve=>{state.releaseClient=resolve;});
       const {createFormatClient}=await import('/fixture/installed-formats/dist/index.js');
       const client=createFormatClient();
       return {prepareImport(engine,request){state.clientCalls.push({direction:'import',format:request.format});return client.prepareImport(engine,request);},
         async export(engine,request){state.clientCalls.push({direction:'export',format:request.format});
           const pending=client.export(engine,request);
           state.exportStarted=true;
           const result=await pending;
           state.exportResult={revision:result.revision,bytes:Array.from(result.bytes)};
           if(options.export==='paused')await new Promise(resolve=>{state.releaseExport=resolve;});
           if(options.export==='wrong-revision')return {...result,revision:result.revision+1};
           return result;},
         cancel(){client.cancel();},dispose(){state.clientDisposals++;client.dispose();}};
     }}:{}),
     ...(options.catalog?{loadProfiles:async signal=>{
       const state=window.formatState;state.profileLoads++;state.profileSignal=signal;
       if(options.catalog==='paused')await new Promise(resolve=>{state.releaseProfiles=resolve;});
       if(signal.aborted)throw new DOMException('Canceled','AbortError');
       if(options.catalog==='failed')throw Error('prepared-profile-load-refused');
       const api=await import('/fixture/installed-formats/dist/index.js');
       const client=api.createFormatClient();client.dispose();
       const response=await fetch('/fixture/installed-formats/capabilities.json',{signal});
       if(!response.ok)throw Error('profile-metadata-unavailable');
       const manifest=await response.json();
       if(options.catalog==='pdf-import')manifest.directions.push({...manifest.directions.find(r=>r.format==='pdf'),direction:'import'});
       if(options.catalog==='duplicate')manifest.directions.push({...manifest.directions[0]});
       if(options.catalog==='invalid-row')manifest.directions[0].fidelity='<img src=x onerror=alert(1)>';
       if(options.catalog==='unknown-schema')manifest.schemaVersion=2;
       if(options.catalog==='over-limit')manifest.directions=Array.from({length:65},()=>manifest.directions[0]);
       if(options.catalog==='empty')manifest.directions=[];
       if(options.catalog==='native-only')for(const row of manifest.directions)row.target='native';
       return {provenance:'CNV-1.18-C2-EI canonical2; formats SHA256 f123c85f410fdb294a0ef880cccbe722f142e63fbb75622c07f4f8424adde0ec',manifest};
     }}:{})}));
  f.root.parentElement.before(controls.element); f.select(f.ids[0],2); await f.settle();
}
