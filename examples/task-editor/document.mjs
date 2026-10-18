import { init } from '@edit-ac/core';
import { CheckpointStorage, taskPreset } from '@edit-ac/web';
// Creation intent survives a failed initial save; opening never seeds over it.
export async function localOptions(name, assetUrl='/core/wasm/editac_wasm_bg.wasm', creation={}) {
  const databaseName=creation.databaseName??`example-${name}`, key=creation.key??`editac-example-${name}`;
  let identity;
  await navigator.locks.request(`${databaseName}-creation`,async()=>{
    identity=JSON.parse(localStorage.getItem(key)??'null');
    if(identity) return;
    const runtime=await init(assetUrl);
    const engine=runtime.createEngine({profile:'v5',documentId:crypto.randomUUID(),epoch:crypto.randomUUID(),nodes:[{text:creation.text??'Plan the task'}]});
    let storage;
    try {
      identity=engine.read().identity;localStorage.setItem(key,JSON.stringify(identity));
      storage=await CheckpointStorage.open(indexedDB,databaseName);
      await storage.publish(engine.checkpoint(),[]);
    } finally {storage?.close();engine.dispose();}
  });
  return {identity,databaseName,assetUrl,indexedDB,locks:navigator.locks,...taskPreset()};
}
