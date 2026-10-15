import { fixture, expectedSemantics, projectedSemantics } from './fixtures.mjs';
import { presetOptions } from './presets.mjs';
import { createEditor, taskPreset, CheckpointStorage, init, ServiceLifecycle, ReferenceLookupSession, DirectSyncAdapter } from './sdk.js';
const check = (value, message) => { if (!value) throw Error(message); };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
export async function run(name, preset, frozen, profile) {
  const runtime = await init('/fixture/wasm/editac_wasm_bg.wasm'), root = document.querySelector('#editor');
  const databaseName = `prf03-${crypto.randomUUID()}`, storage = await CheckpointStorage.open(indexedDB, databaseName);
  try { await storage.publish({ ...frozen.checkpoint, bytes: new Uint8Array(frozen.checkpoint.bytes) }, []); } finally { storage.close(); }
  const editor = createEditor(root, { databaseName, identity: frozen.identity, indexedDB, locks: navigator.locks,
    assetUrl: '/fixture/wasm/editac_wasm_bg.wasm', ...presetOptions(preset, { taskPreset }) });
  let peer, attachment, service, lookup, unsubscribe, selectedSubscription, observer;
  const callbacks = new Set(), timers = new Set(), jobs = [], hosts = [];
  const raw = { fixture: name, preset, observations: [], cleanup: {}, providers: { resolver: 'production-adapter/prepared-host', highlight: 'pending/prepared-envelope-only' } };
  const clock = { now: () => performance.now(), schedule(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return () => { clearTimeout(id); timers.delete(id); }; } };
  const snapshot = phase => ({ phase, at: performance.now(), ...service.state, timers: timers.size, providerCalls: jobs.length });
  try {
    await editor.ready;
    check(JSON.stringify(projectedSemantics(editor.read())) === JSON.stringify(expectedSemantics(fixture(name))), 'Full fixture semantics mismatch');
    raw.initialSemantics = JSON.stringify(projectedSemantics(editor.read())); raw.blocks = fixture(name).blocks.length; raw.chars = fixture(name).chars;
    const initial = editor.read(), blocks = initial.visible.filter(n => n.kind === 'block' && n.runs.some(r => r.text.length > 0));
    check(blocks.length > 1, 'Missing independent editable nodes'); const selected = blocks[0].id, unrelated = blocks[1].id;
    const offsets = Object.fromEntries(blocks.slice(0, 2).map(n => [n.id, n.runs.map(r => r.text).join('').search(/[A-Za-z]/)]));
    check(Object.values(offsets).every(n => n >= 0), 'Missing one-unit ASCII replacement target');
    raw.editOffsets = offsets; raw.editTimingScope = 'public-command preparation and commit; anchor setup excluded; paint unobserved';
    let revision = 0; const context = () => ({ document: JSON.stringify(frozen.identity), session: databaseName, revision: String(revision), permission: 'p1', authorized: true });
    service = new ServiceLifecycle(context, profile.limits, clock);
    const submit = () => {
      const start = performance.now(), controller = new AbortController();
      const promise = service.run({ scope: context(), bytes: 8, items: 1, deadline: start + profile.limits.deadlineMs, signal: controller.signal }, signal => {
        const job = { ...deferred(), signal, started: performance.now() }; jobs.push(job); return job.promise;
      }).then(result => ({ status: result.status, elapsedMs: performance.now() - start }));
      return { promise, controller };
    };
    const states = [], submitted = [];
    for (let i = 0; i < profile.burst; i++) { submitted.push(submit()); states.push(snapshot(`admit-${i}`)); }
    submitted[1].controller.abort(); states.push(snapshot('queued-cancel'));
    submitted[0].controller.abort(); states.push(snapshot('active-cancel-retains-slot'));
    jobs[0].resolve('late'); await flush(); states.push(snapshot('late-completion'));
    check(jobs.length === 2, 'FIFO queued work not started'); jobs[1].resolve('ready');
    const outcomes = await Promise.all(submitted.map(j => j.promise)); await flush(); states.push(snapshot('drained'));
    raw.observations.push({ kind: 'queue', states, outcomes, aborts: jobs.map(j => j.signal.aborted) });
    let providerActive = 0, peak = 0;
    const target = { targetId: 'prepared-target', label: 'Prepared host target' };
    const host = { version: 1, permission: () => ({ revision: 'p1', lookup: true, insert: true }), catalog: targetId => ({ targetId, status: 'cached' }),
      subscribe(fn) { callbacks.add(fn); return { dispose() { callbacks.delete(fn); } }; },
      resolve(request) { const job = { ...deferred(), request }; hosts.push(job); providerActive++; peak = Math.max(peak, providerActive); return job.promise.finally(() => providerActive--); } };
    lookup = new ReferenceLookupSession(host, () => {}, { context: () => context(), clock });
    const search = id => { const start = performance.now(); return lookup.search({ query: 'prepared', requestId: id, signal: new AbortController().signal }).then(results => ({ results: results.length, elapsedMs: performance.now() - start })); };
    const searches = [];
    for (let i = 0; i < profile.burst; i++) searches.push(search(i));
    await flush(); const stormOutcome = lookup.lastOutcome;
    for (const job of hosts) job.resolve([target]);
    const searchOutcomes = await Promise.all(searches); await flush();
    const recover = search(profile.burst); hosts.at(-1).resolve([target]); const recovered = await recover;
    raw.observations.push({ kind: 'resolver-storm', outcomes: searchOutcomes, providerCalls: hosts.length - 1, peak, stormOutcome, recovered,
      staleAdmitted: searchOutcomes.some(o => o.results > 0), activeAfter: providerActive });
    const patches = [], selectedPatches = [], mutationIds = [];
    const rendererTurns = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
    observer = new MutationObserver(records => { for (const record of records) { const node = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      const id = node?.closest('[data-node-id]')?.getAttribute('data-node-id'); if (id) mutationIds.push(id); } });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    unsubscribe = editor.subscribe({ type: 'all' }, patch => patches.push({ sequence: patch.sequence, revision: patch.revision, operation: patch.operation, origin: patch.origin, changedNodes: patch.changedNodes, at: performance.now() }));
    selectedSubscription = editor.subscribe({ type: 'nodes', ids: [selected] }, patch => { selectedPatches.push(patch.sequence); revision++; service.revalidate(); lookup.cancel(); });
    const edit = (owner, node, text) => {
      const at = owner.anchor(node, offsets[node], 'right'), end = owner.anchor(node, offsets[node] + 1, 'left'), start = performance.now();
      const commands = [{ type: 'delete', range: { anchor: at, focus: end } }, { type: 'insert', at, text }];
      try { if (owner === editor) { const result = owner.chain('prf03').command(commands[0]).command(commands[1]).run(); if (result.caret) owner.releaseAnchor(result.caret); }
        else { const plan = owner.prepare({ kind: 'editor', origin: 'local:prf03-peer', commands }); try { const result = owner.commit(plan); if (result.caret) owner.releaseAnchor(result.caret); } finally { owner.releasePlan(plan); } }
      } finally { owner.releaseAnchor(at); owner.releaseAnchor(end); } return performance.now() - start;
    };
    const pending = [submit(), submit(), submit()]; const beforeJobs = jobs.length;
    const unrelatedMs = edit(editor, unrelated, 'u'); await rendererTurns(); const afterUnrelated = snapshot('unrelated-edit');
    const unrelatedPatches = patches.slice(), unrelatedMutations = [...new Set(mutationIds)]; mutationIds.length = 0;
    const selectedBefore = selectedPatches.length, localSamples = [];
    for (let i = 0; i < profile.localEdits; i++) localSamples.push({ index: i, elapsedMs: edit(editor, selected, String.fromCharCode(97 + i)) });
    await rendererTurns();
    const localPatches = patches.slice(unrelatedPatches.length), localMutations = [...new Set(mutationIds)]; mutationIds.length = 0;
    const invalidated = await Promise.all(pending.map(p => p.promise)); const afterSelected = snapshot('selected-edits');
    jobs.at(-1).resolve('obsolete'); await flush();
    raw.observations.push({ kind: 'edit-invalidation', unrelatedMs, afterUnrelated, afterSelected, outcomes: invalidated, providerCallsDuringInvalidation: jobs.length - beforeJobs,
      selectedEvents: selectedPatches.length - selectedBefore, localSamples, selected, unrelated, unrelatedPatches, unrelatedMutations, localPatches, localMutations });
    await editor.flush({ target: 'local' });
    peer = runtime.restoreEngine(frozen.identity, editor.recoveryExport().checkpoint);
    const adapter = new DirectSyncAdapter(peer, frozen.identity), replies = [], transport = [];
    attachment = await editor.attachSync({ authorized: true, peerIdentity: frozen.identity, transport: { send(frame) { transport.push({ bytes: frame.byteLength, at: performance.now() }); const result = adapter.receive(frame); if (result.reply) replies.push(result.reply); return true; } } });
    const pumps = [];
    async function pump() { const start = performance.now(); await attachment.pump(Math.floor(start)); while (replies.length) attachment.receive(replies.shift()); pumps.push({ elapsedMs: performance.now() - start, ...attachment.state }); }
    attachment.receive(adapter.step1()); for (let i = 0; i < 6; i++) await pump();
    const firstRemote = patches.length, samples = [], frameBytes = [], staleSearch = search(profile.burst + 1), staleJob = hosts.at(-1);
    for (let i = 0; i < profile.remoteEdits; i++) { const vector = peer.stateVector(); samples.push({ index: i, elapsedMs: edit(peer, selected, String.fromCharCode(65 + i)) });
      const frame = adapter.update(peer.encodeUpdate(vector)); frameBytes.push(frame.byteLength); attachment.receive(frame); }
    const queued = attachment.state;
    for (let i = 0; i < 12; i++) await pump();
    staleJob.resolve([target]); const staleOutcome = await staleSearch;
    await editor.flush({ target: 'local' }); await rendererTurns();
    const final = editor.read(), remotePatches = patches.slice(firstRemote).filter(p => p.operation === 'Remote');
    const converged = JSON.stringify(projectedSemantics(final)) === JSON.stringify(projectedSemantics(peer.read()));
    observer.disconnect();
    raw.observations.push({ kind: 'collaboration', samples, frameBytes, queued, pumps, transport, remotePatches, staleOutcome, converged, mutations: [...new Set(mutationIds)] });
    raw.patches = patches; raw.selectedPatches = selectedPatches; raw.mutationIds = [...new Set(mutationIds)]; raw.selected = selected; raw.unrelated = unrelated;
    raw.finalChars = final.visible.filter(n => n.kind === 'block').reduce((sum, n) => sum + n.runs.reduce((a, r) => a + r.text.length, 0), 0);
    raw.initialChars = initial.visible.filter(n => n.kind === 'block').reduce((sum, n) => sum + n.runs.reduce((a, r) => a + r.text.length, 0), 0);
    raw.finalText = { selected: final.visible.find(n => n.id === selected).runs.map(r => r.text).join(''), unrelated: final.visible.find(n => n.id === unrelated).runs.map(r => r.text).join(''),
      initialSelected: blocks[0].runs.map(r => r.text).join(''), initialUnrelated: blocks[1].runs.map(r => r.text).join('') };
    raw.correctness = 'observed';
  } catch (error) { raw.failure = error.stack ?? String(error); } finally {
    observer?.disconnect(); unsubscribe?.(); selectedSubscription?.(); attachment?.detach(); peer?.dispose(); lookup?.dispose(); service?.dispose();
    for (const job of jobs) job.resolve('cleanup'); for (const job of hosts) job.resolve([]); await flush();
    raw.cleanup = { timers: timers.size, hostListeners: callbacks.size, service: service?.state };
    const close = await editor.destroy({ policy: 'flush' }); raw.cleanup.unsaved = close.unsaved;
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(databaseName); request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(Error('Database deletion blocked')); });
    raw.cleanup.databaseDeleted = true;
  }
  return raw;
}
