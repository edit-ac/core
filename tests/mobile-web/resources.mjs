// Test-only accounting of browser resources; never substitutes for engine state.
export function installResourceCounters() {
  const records=[], observers=new Set(), frames=new Set(), timers=new Set(), intervals=new Set(), captures=new Set();
  const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
  const capture=o=>typeof o==='boolean'?o:!!o?.capture;
  EventTarget.prototype.addEventListener=function(type,listener,options){
    if(!listener)return add.call(this,type,listener,options);
    const old=records.find(r=>r.target===this&&r.type===type&&r.listener===listener&&r.capture===capture(options));
    if(old)return;
    const record={target:this,type,listener,capture:capture(options)};
    const forget=()=>{const i=records.indexOf(record);if(i>=0)records.splice(i,1);};
    record.wrapped=function(event){if(options?.once)forget();return typeof listener==='function'?listener.call(this,event):listener.handleEvent(event);};
    if(!options?.signal?.aborted){records.push(record);if(options?.signal)add.call(options.signal,'abort',forget,{once:true});}
    return add.call(this,type,record.wrapped,options);
  };
  EventTarget.prototype.removeEventListener=function(type,listener,options){const r=records.find(r=>r.target===this&&r.type===type&&r.listener===listener&&r.capture===capture(options));if(r)records.splice(records.indexOf(r),1);return remove.call(this,type,r?.wrapped??listener,options);};
  for(const name of ['MutationObserver','ResizeObserver','IntersectionObserver']){const Original=window[name];if(!Original)continue;window[name]=class extends Original{observe(...args){observers.add(this);return super.observe(...args);}disconnect(){observers.delete(this);return super.disconnect();}};}
  const raf=window.requestAnimationFrame,caf=window.cancelAnimationFrame;
  window.requestAnimationFrame=callback=>{const id=raf.call(window,time=>{frames.delete(id);callback(time);});frames.add(id);return id;};
  window.cancelAnimationFrame=id=>{frames.delete(id);return caf.call(window,id);};
  const timeout=window.setTimeout,clear=window.clearTimeout;
  window.setTimeout=(callback,delay,...args)=>{const id=timeout.call(window,()=>{timers.delete(id);typeof callback==='function'?callback(...args):window.eval(callback);},delay);timers.add(id);return id;};
  window.clearTimeout=id=>{timers.delete(id);return clear.call(window,id);};
  const interval=window.setInterval,clearInterval=window.clearInterval;
  window.setInterval=(...args)=>{const id=interval.apply(window,args);intervals.add(id);return id;};
  window.clearInterval=id=>{intervals.delete(id);return clearInterval.call(window,id);};
  const set=Element.prototype.setPointerCapture,release=Element.prototype.releasePointerCapture;
  Element.prototype.setPointerCapture=function(id){set.call(this,id);captures.add(id);};
  Element.prototype.releasePointerCapture=function(id){release.call(this,id);captures.delete(id);};
  add.call(document,'lostpointercapture',e=>captures.delete(e.pointerId),true);
  window.mobileResources=()=>({listeners:records.filter(r=>r.target===window||r.target===document||r.target instanceof Element&&r.target.closest('#scroll-root')).length,observers:observers.size,frames:frames.size,timers:timers.size,intervals:intervals.size,captures:captures.size});
}
