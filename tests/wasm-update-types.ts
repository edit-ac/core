import { type EngineRuntime, type Checkpoint, type ReplayUpdate, type Patch, type PatchSubscription } from '@edit-ac/core';
function consumer(runtime: EngineRuntime, checkpoint: Checkpoint, journal: readonly ReplayUpdate[]) {
  const e = runtime.restoreEngine(checkpoint.identity, checkpoint, journal);
  const vector: Uint8Array = e.stateVector();
  const update: ReplayUpdate = e.encodeUpdate(vector);
  const sub: PatchSubscription = e.subscribe({type:'updates'}, (patch: Patch) => {
    if (patch.update) e.applyUpdate(patch.update);
  });
  e.checkpoint(); e.takeObserverErrors(); sub.dispose(); e.dispose();
  // @ts-expect-error byte transports require owned Uint8Array values
  e.applyUpdate({identity: update.identity, bytes:[0]});
  // @ts-expect-error scope ids must be strings
  e.subscribe({type:'nodes', ids:[3]}, () => {});
  // @ts-expect-error restoration requires explicit initialization/provenance
  runtime.restoreEngine(checkpoint.identity, {identity:checkpoint.identity,bytes:checkpoint.bytes});
}
void consumer;
