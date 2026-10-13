import { init } from '@edit-ac/core';
import { CheckpointStorage } from '@edit-ac/web';
import { installEditorHosts } from '@edit-ac/astro';

// Importing the server page never executes this browser script. The host opens
// an existing local identity; first-run creation is an explicit application action.
async function options(name) {
  const assetUrl = '/engine.wasm';
  const runtime = await init(assetUrl);
  const databaseName = `astro-task-${name}`;
  const identityKey = `editac-astro-identity-${name}`;
  let identity = JSON.parse(localStorage.getItem(identityKey) ?? 'null');
  if (!identity) {
    const engine = runtime.createEngine({ profile:'v5', documentId:crypto.randomUUID(), epoch:crypto.randomUUID(), nodes:[{text:name === 'task' ? 'alpha' : 'beta'}] });
    const storage = await CheckpointStorage.open(indexedDB, databaseName);
    try {
      await storage.publish(engine.checkpoint(), []);
      identity = engine.read().identity;
      localStorage.setItem(identityKey, JSON.stringify(identity));
    } finally { storage.close(); engine.dispose(); }
  }
  return { identity, databaseName, assetUrl, indexedDB, locks:navigator.locks, plainPasteControl:false };
}
if (import.meta.env.PUBLIC_EDITAC_ASTRO_FIXTURE === '1') {
  const { installFixture } = await import('../../../fixtures/browser-astro/ports.js');
  installFixture(options);
} else {
  installEditorHosts(document, options, {
    onError(error) { console.error('Editor loading/saving failed', error); },
    onDispose(result) {
      if (result.unsaved) {
        // The host must retain/export this explicit report before discarding it.
        window.dispatchEvent(new CustomEvent('editac:unsaved', {detail:result}));
      }
    },
  });
}
