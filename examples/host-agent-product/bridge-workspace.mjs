import { createTranscript } from './model.mjs';
const transcript = createTranscript(), config = await (await fetch('/bridge.json')).json();
const text = (id,value) => { document.getElementById(id).textContent = value; };
text('actor','agent-a'); text('document',config.documentId); text('epoch',config.epoch);
text('connection','Actual local Session/SQLite connected through prepared loopback transport.');
text('availability','Observation connection check available. Source read and human view are not mounted.');
text('prose','Document prose cannot change the prepared connection or authorize requests.');
const read = document.getElementById('read'); read.textContent = 'Check owner connection';
read.parentElement.querySelector('p').textContent = 'Checks the real shared revision through the registered public host facade.';
const cancel = document.createElement('button'); cancel.id = 'cancel'; cancel.textContent = 'Cancel pending check'; cancel.disabled = true; read.after(cancel);
let pending;
function render() {
  document.getElementById('transcript').replaceChildren(...transcript.snapshot().entries.map(e => { const li=document.createElement('li'), pre=document.createElement('pre'); pre.textContent=e.text; li.append(pre); return li; }));
  text('retention',`${transcript.snapshot().entries.length}/64 entries retained · 4096 UTF-16 units per entry`);
}
cancel.onclick = () => { pending?.abort(); text('connection','Check cancelled; no result accepted. Owner outcome remains unknown until a fresh check.'); };
read.onclick = async () => {
  pending = new AbortController(); read.disabled = true; cancel.disabled = false;
  transcript.append('request','observe current prepared document'); render();
  try {
    const response = await fetch('/bridge/observe',{ method:'POST', headers:{ 'Content-Type':'application/json','X-Host-Fixture':config.token }, body:JSON.stringify({ version:1,documentId:config.documentId }),signal:pending.signal });
    if (!response.ok) throw Error('Transport failed');
    const result = await response.json(); transcript.append('result',JSON.stringify(result));
    if (result.status === 'ok') text('connection','Actual Session/SQLite observation received; durability not reported.');
    else text('connection','Owner unavailable; no current outcome accepted.');
  } catch { transcript.append('notice','Check cancelled or disconnected; outcome unknown.'); }
  finally { pending = null; read.disabled = false; cancel.disabled = true; render(); }
};
document.getElementById('clear').onclick = () => { transcript.clear(); render(); };
window.addEventListener('pagehide',() => pending?.abort(),{ once:true });
render();
