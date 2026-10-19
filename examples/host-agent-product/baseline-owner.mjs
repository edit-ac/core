// Consumer lifetime fencing around the public retained-baseline owner, never a
// source reconciler or durable mutation store. Only Session prepares semantics.
export function baselineOwner({ createHostPrepare, send, available, access, onCapture = () => {}, now = Date.now }) {
  let api, generation = 0, offset = 0, closed = false, retained, releaseError;
  const releases = new Set();
  const release = target => {
    const pending = send({ op:'release', target });
    releases.add(pending); pending.catch(error => { releaseError = error; }).finally(() => releases.delete(pending));
  };
  const make = () => createHostPrepare({
    available: a => !closed && available(a),
    async capture() { const value = await send({ op:'capture' }); onCapture(value.target); return value; },
    prepare: (target,candidate,a) => send({ op:'prepare_markdown',target,candidate,access:a }),
    release,
  }, { limits:{ maxSourceBytes:16384,maxBaselines:8 }, now:() => now()+offset });
  api = make();
  // Reset synchronously changes the generation; old async results stay old.
  async function reset(final = false) {
    const old = api; retained = undefined; generation++; closed = final; api = final ? null : make();
    await old?.dispose(); await Promise.allSettled([...releases]);
    if (releaseError) { const error = releaseError; releaseError = undefined; throw error; }
  }
  const services = Object.fromEntries(['read','prepare'].map(name => [name,{
    available:a => !closed && api.services[name].available(a),
    async execute(request,a) {
      const current = api, version = generation;
      if (closed) return {status:'rejected',code:'unavailable'};
      const result = await current.services[name].execute(request,a);
      if (name === 'read' && result.source && version === generation) retained = {revision:result.revision,sourceHash:result.sourceHash,profile:result.profile,expiresAt:result.expiresAt};
      return version === generation && !closed ? result : {status:'rejected',code:'expired'};
    },
  }]));
  return {
    services, reset,
    get generation() { return generation; },
    // Explicit prepared clock injection. No real owner result is substituted.
    expire() { offset += 300001; },
    async check(input) {
      const a = access();
      if (!a || !available(a)) return {status:'rejected',code:'denied'};
      if (!input || input.actorId !== a.actorId || input.documentId !== a.documentId || input.epoch !== a.epoch)
        return {status:'rejected',code:'foreign-baseline'};
      if (input.generation !== generation)
        return {status:'rejected',code:'expired'};
      if (!retained || ['revision','sourceHash','profile','expiresAt'].some(k => input[k] !== retained[k])) return {status:'rejected',code:'mismatch'};
      const current = api, version = generation;
      try {
        // Reuse public baseline admission to check revision/hash retention.
        const u = await current.beginUpload(a,{expectedRevision:input.revision,sourceHash:input.sourceHash,totalBytes:0,checksum:'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'});
        await current.cancelUpload(a,u.uploadId);
        const observed = await send({op:'observe',access:a});
        if (version !== generation || !available(a)) return {status:'rejected',code:'expired'};
        if (observed.revision !== input.revision) return {status:'rejected',code:'changed',currentRevision:observed.revision};
        return {status:'valid',revision:observed.revision};
      } catch (error) {
        return {status:'rejected',code:now()+offset >= input.expiresAt ? 'expired' : ['mismatch','expired','denied','unavailable'].includes(error.code) ? error.code : 'unknown'};
      }
    },
  };
}
