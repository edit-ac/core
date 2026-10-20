import './upload-workspace.mjs';
const section=document.createElement('section');
section.setAttribute('aria-labelledby','proposal-cancel-heading');
section.innerHTML=`<h2 id="proposal-cancel-heading">Proposal lifetime</h2>
<p>Cancel clears this view and releases retained baseline and upload work through the existing owner. An in-flight prepare may finish; its late result is withheld. This does not undo document edits or promise cancellation of a shared owner operation.</p>
<button id="proposal-cancel">Cancel proposal workflow</button>
<p id="proposal-cancel-status" role="status">Capture and prepare explicitly. No automatic apply.</p>`;
document.querySelector('.workspace').append(section);
document.title='Local prepared proposal lifetime';
document.getElementById('proposal-cancel').onclick=()=>window.dispatchEvent(new Event('host-proposal-cancel'));
window.addEventListener('host-proposal-invalidated',event=>{document.getElementById('proposal-cancel-status').textContent=event.detail.message+' Document edits are preserved. Capture a fresh baseline explicitly.';});
