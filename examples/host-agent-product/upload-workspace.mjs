import './baseline-workspace.mjs';
import { candidateChunks, checksum } from './upload-input.mjs';
const config = await (await fetch('/bridge.json')).json();
const section = document.createElement('section');
section.id='upload-region';
section.setAttribute('aria-labelledby','upload-heading');
section.innerHTML = `<h2 id="upload-heading">Local complete candidate upload</h2>
<p>Paste complete Markdown, including unchanged content. Local text only; URLs are inert text. UTF-8 limit: 4096 bytes; chunks: 1024 bytes. Upload does not edit the document. Prepare calls the real shared owner only after complete admission.</p>
<label for="upload-source">Complete candidate Markdown</label><textarea id="upload-source" rows="7" maxlength="8192"></textarea>
<button id="upload-start">Begin local upload</button><button id="upload-next" disabled>Send next chunk</button><button id="upload-finish" disabled>Prepare complete candidate</button><button id="upload-cancel" disabled>Discard upload</button>
<p id="upload-status" role="status">Capture a baseline, then enter a local candidate.</p><progress id="upload-progress" max="4096" value="0" aria-label="Admitted UTF-8 bytes"></progress><pre id="upload-metadata"></pre>`;
document.querySelector('.workspace').append(section);
document.title='Local prepared candidate upload';
const node=id=>document.getElementById('upload-'+id);
let upload, pending, generation=0, ended=false, boundMetadata='';
const metadata=()=>document.getElementById('baseline-metadata').textContent;
function render() {
  section.setAttribute('aria-busy',String(!!pending));
  node('start').disabled=ended || !!pending || !!upload || !metadata();
  node('source').disabled=!!upload || !!pending || ended;
  node('next').disabled=!!pending || !upload || upload.index>=upload.chunks.length;
  node('finish').disabled=!!pending || !upload || upload.received!==upload.total;
  node('cancel').disabled=!upload && !pending;
}
async function post(input,signal,keepalive=false) {
  const r=await fetch('/bridge/baseline',{method:'POST',headers:{'Content-Type':'application/json','X-Host-Fixture':config.token},body:JSON.stringify(input),signal,keepalive});
  if(!r.ok)throw Error('Upload transport unavailable');return r.json();
}
function discard(message,keepalive=false) {
  generation++;pending?.abort();pending=undefined;
  const old=upload;upload=undefined;node('metadata').textContent='';node('progress').value=0;node('status').textContent=message;render();
  if(old)void post({action:'upload-cancel',generation:old.generation,uploadId:old.uploadId},undefined,keepalive).catch(()=>{});
}
async function run(action) {
  if(pending || ended)return;
  const version=generation,controller=new AbortController();pending=controller;render();
  const timer=setTimeout(()=>controller.abort(),5000);
  try {await action(controller.signal,()=>version===generation && !ended);}
  catch {if(version===generation)discard('Upload outcome unknown. Discarded locally; release baseline before retrying.');}
  finally {clearTimeout(timer);if(pending===controller)pending=undefined;render();}
}
const reject=result=>{discard('Upload rejected: '+(result.code ?? result.status)+'. No document mutation. Capture again if baseline expired or changed.');};
node('start').onclick=()=>run(async(signal,current)=>{
  let candidate;try {candidate=candidateChunks(node('source').value);}catch {node('status').textContent='Invalid candidate: use well-formed Unicode within 4096 UTF-8 bytes.';return;}
  const {revision,sourceHash,profile,expiresAt,actorId,documentId,epoch,generation:ownerGeneration}=JSON.parse(metadata());
  const baseline={revision,sourceHash,profile,expiresAt,actorId,documentId,epoch,generation:ownerGeneration};
  const result=await post({action:'upload-begin',generation:ownerGeneration,baseline,totalBytes:candidate.total,checksum:await checksum(candidate.source)},signal);
  if(!current())return;
  if(result.status!=='uploading' || typeof result.uploadId!=='string'){reject(result);return;}
  upload={...candidate,...result,generation:ownerGeneration,index:0,received:0};
  node('progress').max=Math.max(1,candidate.total);node('progress').value=0;
  node('metadata').textContent=JSON.stringify({totalBytes:candidate.total,checksum:await checksum(candidate.source),expiresAt:result.expiresAt,profile},null,2);
  node('status').textContent=`Partial upload: 0 / ${candidate.total} UTF-8 bytes. Nothing prepared.`;
});
node('next').onclick=()=>run(async(signal,current)=>{
  const u=upload,text=u.chunks[u.index];
  const result=await post({action:'upload-chunk',generation:u.generation,uploadId:u.uploadId,index:u.index,text,checksum:await checksum(text)},signal);
  if(!current())return;
  const expected=u.received+new TextEncoder().encode(text).length;
  if(result.status!=='partial' || result.receivedBytes!==expected){reject(result);return;}
  u.index++;u.received=result.receivedBytes;node('progress').value=u.received;
  node('status').textContent=u.received===u.total ? `Complete upload admitted: ${u.total} UTF-8 bytes. Prepare explicitly.` : `Partial upload: ${u.received} / ${u.total} UTF-8 bytes. Nothing prepared.`;
});
node('finish').onclick=()=>run(async(signal,current)=>{
  const u=upload;const result=await post({action:'upload-finish',generation:u.generation,uploadId:u.uploadId},signal);
  if(!current())return;
  upload=undefined;
  node('status').textContent=result.status==='prepared' ? 'Complete candidate prepared by shared owner. Document unchanged. Preview is a separate workflow.' : result.status==='conflict' ? 'Shared owner conflict: '+result.code+'. Document unchanged; capture a fresh baseline.' : 'Upload rejected: '+(result.code ?? 'unknown')+'. Document unchanged.';
  // The opaque owner ID is retained only as presentation metadata; never reconstructed or applied.
  node('metadata').textContent=JSON.stringify({status:result.status,code:result.code,proposalId:result.proposalId,candidateHash:result.candidateHash},null,2);
});
node('cancel').onclick=()=>discard('Upload discarded. No document mutation.');
new MutationObserver(()=>{const next=metadata();if(next!==boundMetadata){boundMetadata=next;if(!next)node('source').value='';discard(next?'Baseline changed; start a new local upload.':'No baseline; upload discarded.');}render();}).observe(document.getElementById('baseline-metadata'),{childList:true,characterData:true,subtree:true});
window.addEventListener('pagehide',()=>{ended=true;discard('View closed.',true);node('source').value='';},{once:true});
render();
