import './human-workspace.mjs';
const config = await (await fetch('/bridge.json')).json();
const section = document.createElement('section');
section.id='baseline-region';
section.setAttribute('aria-labelledby','baseline-heading');
section.innerHTML = `<h2 id="baseline-heading">Revision-bound baseline</h2>
<p>Exact captured Markdown and profile from the local shared owner. This is an opening representation, not current semantic state or a durable apply receipt. Prepared local authorization only.</p>
<label for="baseline-scope">Proposal scope</label><select id="baseline-scope"><option value="current">Current authorized document</option><option value="other">Other document (unavailable)</option></select>
<button id="baseline-capture">Capture baseline</button><button id="baseline-check" disabled>Check retained baseline</button><button id="baseline-release">Release baseline</button>
<button id="baseline-expire" disabled>Expire baseline (prepared clock)</button>
<p id="baseline-status" role="status">No retained baseline. Capture explicitly.</p><pre id="baseline-metadata"></pre><pre id="baseline-source" tabindex="0" aria-label="Exact baseline source"></pre>`;
document.querySelector('.workspace').append(section);
document.title = 'Local prepared proposal baseline';
document.querySelector('#policy option[value="authorized"]').textContent='Authorized read / prepare';
const node = id => document.getElementById('baseline-'+id);
let baseline, generation = 0, pending, ended = false, permitted = true;
const clear = message => { baseline = undefined; node('source').textContent=''; node('metadata').textContent=''; node('status').textContent=message; };
function render() {
  section.setAttribute('aria-busy',String(!!pending));
  const enabled = !ended && permitted && node('scope').value === 'current';
  node('capture').disabled=!!pending || !enabled;
  node('check').disabled=!!pending || !enabled || !baseline;
  node('expire').disabled=!!pending || !enabled || !baseline;
}
async function post(input,signal,keepalive=false) {
  const response=await fetch('/bridge/baseline',{method:'POST',headers:{'Content-Type':'application/json','X-Host-Fixture':config.token},body:JSON.stringify(input),signal,keepalive});
  if(!response.ok)throw Error('Baseline transport unavailable');return response.json();
}
async function release(message) {
  const version=++generation; pending?.abort();
  const controller=new AbortController();pending=controller;clear(message);render();
  window.dispatchEvent(new CustomEvent('host-proposal-invalidated',{detail:{message}}));
  const timer=setTimeout(()=>controller.abort(),5000);
  try { await post({action:'release'},controller.signal); }
  catch { if(version===generation && !ended)node('status').textContent='Release outcome unknown; capture again after reconnecting.'; }
  finally {clearTimeout(timer);if(pending===controller)pending=undefined;render();}
}
async function run(action) {
  if(pending || ended)return;
  const version=generation,controller=new AbortController();pending=controller;render();
  const timeout=setTimeout(()=>controller.abort(),5000);
  try { await action(controller.signal,version); }
  catch { if(version===generation)clear('Baseline outcome unknown; release and capture again.'); }
  finally {clearTimeout(timeout);if(pending===controller)pending=undefined;render();}
}
node('capture').onclick=()=>run(async(signal,version)=>{
  clear('Capturing exact source…');const released=await post({action:'release'},signal);
  if(version!==generation || ended)return;
  const result=await post({action:'capture',generation:released.generation},signal);
  if(version!==generation || ended)return;
  const b=result.baseline;
  if(result.status!=='captured' || typeof b?.source!=='string' || new TextEncoder().encode(b.source).length>16384 || typeof b.profile!=='string' || typeof b.revision!=='string' || !/^sha256:[a-f0-9]{64}$/.test(b.sourceHash) || !Number.isSafeInteger(b.expiresAt)) {clear('Baseline invalid: '+(result.code ?? 'invalid'));return;}
  const {source,diagnostics,...metadata}=b;
  baseline=structuredClone(metadata);node('source').textContent=source;
  node('metadata').textContent=JSON.stringify({...b,source:undefined},null,2);
  node('status').textContent='Baseline retained by shared owner. Current document may change; check before reuse.';
});
node('check').onclick=()=>run(async(signal,version)=>{
  const result=await post({action:'check',baseline},signal);
  if(version!==generation || ended)return;
  node('status').textContent=result.status==='valid' ? 'Baseline valid at observed revision. No mutation.' : 'Baseline invalid: '+result.code+'. No mutation; capture a fresh baseline.';
  if(result.status!=='valid'){baseline=undefined;node('source').textContent='';node('metadata').textContent='';}
});
node('expire').onclick=()=>run(async(signal,version)=>{await post({action:'expire'},signal);if(version===generation)node('status').textContent='Prepared clock advanced. Check baseline to observe expiry.';});
window.addEventListener('host-proposal-cancel',()=>void release('Proposal workflow cancelled; retained baseline released.'));
node('release').onclick=()=>void release('Baseline released; no proposal content retained in this view.');
node('scope').onchange=()=>void release(node('scope').value==='current'?'Scope changed; capture again.':'Foreign scope unavailable; baseline invalid.');
document.getElementById('human-scope').addEventListener('change',()=>void release('Human scope changed; baseline invalid.'));
document.getElementById('human-close').addEventListener('click',()=>void release('Editor closed; baseline released.'));
document.getElementById('policy').addEventListener('change',()=>void release('Authority changed; baseline invalid.'));
window.addEventListener('host-workspace-inventory',event=>{permitted=event.detail.humanAvailable;if(!permitted)void release('Authority unavailable; baseline invalid.');else render();});
window.addEventListener('pagehide',()=>{ended=true;generation++;pending?.abort();clear('View closed');void post({action:'release'},undefined,true).catch(()=>{});},{once:true});
render();
