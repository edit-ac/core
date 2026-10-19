import { createHostAgent } from '@edit-ac/web/host';
import { createTranscript, LIMITS } from './model.mjs';
const fixture = await (await fetch('/fixture/shell.json')).json();
const transcript = createTranscript();
const text = (id, value) => { document.getElementById(id).textContent = value; };
text('actor', fixture.actorId); text('document', fixture.documentId); text('epoch', fixture.epoch); text('prose', fixture.prose);
// This context is prepared host infrastructure, never derived from document prose.
const context = Object.freeze({ session: 'local-prepared-session' });
const host = createHostAgent({ services: {}, authorize: (requestContext, documentId) => requestContext === context && documentId === fixture.documentId ? {
  actorId: fixture.actorId, documentId, epoch: fixture.epoch, permissions: ['read'], readOnly: true,
} : null });
function render() {
  const snapshot = transcript.snapshot(), list = document.getElementById('transcript');
  list.replaceChildren(...snapshot.entries.map(entry => {
    const li = document.createElement('li'), label = document.createElement('span'), body = document.createElement('pre');
    label.className = 'kind'; label.textContent = `${entry.kind} #${entry.id}`;
    body.textContent = entry.text;
    li.append(label, body);
    if (entry.truncated) { const note = document.createElement('small'); note.textContent = `Truncated at ${LIMITS.text} UTF-16 units`; li.append(note); }
    return li;
  }));
  text('retention', `${snapshot.entries.length}/${LIMITS.entries} entries retained · ${snapshot.dropped} older entries discarded · ${LIMITS.text} UTF-16 units per entry`);
}
transcript.append('notice', 'Session disconnected; read, prepare, apply, receipts and observation unavailable.');
transcript.append('prose', fixture.prose);
transcript.append('result', fixture.uncertainResult);
render();
const available = await host.capabilities(context, fixture.documentId);
text('availability', available.length ? available.join(', ') : 'No authorized tools available (no services installed).');
document.getElementById('read').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  transcript.append('request', JSON.stringify({ operation: 'read', version: 1, documentId: fixture.documentId, representation: 'markdown' })); render();
  try {
    const result = await host.call('read', { version: 1, documentId: fixture.documentId, representation: 'markdown' }, context);
    transcript.append('result', JSON.stringify(result));
  } catch { transcript.append('notice', 'Public facade check failed; no owner outcome is known.'); }
  finally { render(); button.disabled = false; }
});
document.getElementById('clear').addEventListener('click', () => { transcript.clear(); render(); });
