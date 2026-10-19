export async function prepareOfflineShell(){
  const status=document.querySelector('#offline-message');
  if(!location.pathname.startsWith('/fixture/')){
    status.textContent='For offline reload, open the offline workspace link first.';return false;
  }
  try{
    if(!navigator.serviceWorker)throw Error('Service workers unavailable');
    await navigator.serviceWorker.register('./offline-worker.mjs',{type:'module'});
    const registration=await navigator.serviceWorker.ready;
    // Readiness includes control of this page, not only an active registration.
    if(!navigator.serviceWorker.controller)await new Promise(resolve=>{
      navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true});
    });
    const urls=[...new Set([location.origin+'/fixture/index.html',...performance.getEntriesByType('resource').map(entry=>entry.name).filter(url=>['/fixture/','/core/','/web/'].some(path=>url.startsWith(location.origin+path)))])];
    await new Promise((resolve,reject)=>{
      const channel=new MessageChannel();
      const timeout=setTimeout(()=>{channel.port1.close();reject(Error('Offline shell preparation timed out'));},10000);
      channel.port1.onmessage=event=>{clearTimeout(timeout);channel.port1.close();event.data.ready?(status.dataset.shell=JSON.stringify(event.data),resolve()):reject(Error(event.data.error));};
      registration.active.postMessage({type:'prepare-local-shell',urls},[channel.port2]);
    });
    status.dataset.state='ready';status.textContent='App available for offline reload in this browser. Documents are saved locally only.';return true;
  }catch(error){status.dataset.state='error';status.textContent=`Offline reload unavailable: ${error.message}`;return false;}
}
