// Only the local application's code/assets are cached. Documents stay in IndexedDB.
const cacheName='task-editor-shell-v2';
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('message',event=>{
  if(event.data?.type!=='prepare-local-shell')return;
  event.waitUntil((async()=>{
    try{
      const urls=event.data.urls;
      if(!Array.isArray(urls)||urls.some(url=>new URL(url,self.location).origin!==self.location.origin))throw Error('Invalid local shell URLs');
      const cache=await caches.open(cacheName);
      await cache.addAll(urls);
      // Acknowledge only after every shell entry can actually be read back.
      for(const url of urls)if(!await cache.match(url))throw Error('Missing prepared shell entry: '+url);
      event.ports[0]?.postMessage({ready:true,urls,state:self.registration.active?.state});
    }catch(error){event.ports[0]?.postMessage({error:error.message});}
  })());
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  // Preparation pins the app shell. Serve its cached code consistently in every
  // engine; an explicit online Prepare action refreshes these entries. Never
  // cache document bytes or make offline restore depend on a network attempt.
  event.respondWith((async()=>{
    const cache=await caches.open(cacheName);
    const cached=await cache.match(event.request,{ignoreSearch:true});
    if(cached)return cached;
    return fetch(event.request);
  })());
});
