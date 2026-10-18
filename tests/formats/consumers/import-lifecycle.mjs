import assert from 'node:assert/strict';

// Runs against each family's authored package, real worker, owner and IndexedDB.
export function registerImportLifecycleTests(mediaTest,source) {
  mediaTest('prepared import bounds asset initialization and fences late completion',async page=>{
    const rows=await page.evaluate(async()=>{
      const rows=[];
      for(const mode of ['cancel','dispose','signal','timeout','rejection']) {
        const f=await mediaSetup(),signal=new AbortController();
        const p=await f.prepare({signal:signal.signal,timeoutMs:1000}),before=f.snapshot();
        let release,entered;
        const started=new Promise(resolve=>{entered=resolve;});
        const owner={...f.owner,enableAssets:()=>{entered();return new Promise((resolve,reject)=>{
          release=()=>mode==='rejection'?reject(Error('prepared initialization failure')):resolve(f.assets);
        });}};
        const pending=p.commitAssets(owner,f.job,f.host,f.sourceGrant).then(
          ()=>({unexpected:true}),e=>({code:e.code,original:Array.from(e.original),recovery:!!e.recovery}));
        await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(Error('initialization was not invoked')),3000))]);
        if(mode==='cancel')f.client.cancel();
        if(mode==='dispose')f.client.dispose();
        if(mode==='signal')signal.abort();
        if(mode==='rejection')release();
        const bounded=await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve(null),2500))]);
        release();
        const result=await pending;
        // Drain the late initialization continuation before inspecting durable state.
        await new Promise(resolve=>setTimeout(resolve,0));
        const after=f.snapshot(),journal=await f.assets.inspect(),entries=await f.entries();
        rows.push({mode,bounded:!!bounded,result,before,after,journal,entries,calls:f.calls});
        await f.close();
      }
      return rows;
    });
    for(const r of rows) {
      assert.ok(r.bounded,r.mode+' must finish before initialization is released');
      assert.equal(r.result.code,r.mode==='timeout'?'Timeout':r.mode==='rejection'?'CommitRejected':'Cancelled');
      assert.ok(r.result.recovery);
      assert.deepEqual(r.result.original,source);
      assert.deepEqual(r.after,r.before);
      assert.equal(r.journal.prepared.length,0);
      assert.equal(r.entries.length,0);
      assert.deepEqual(r.calls,[]);
    }
    return rows;
  });

}
