export const assert = (condition, message) => { if (!condition) throw Error(message); };
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export const environment = { schema:'editac.registry.editor.v5',capabilities:['commands','host-resolver','source-fallback'],allowContractFixtures:true };
export async function runContractChecks(api, fixture) {
  const {prepareExtensionProfile:prepare,ExtensionProfileActivation:Activation,FIRST_PARTY_PROFILES:profiles,FIRST_PARTY_FEATURES:features} = api;
  const cases = [];
  const check = async (id,name,run) => { await run(); cases.push({id,name,passed:true}); };
  const rejects = (profile,catalog,env,code) => {
    try { prepare(profile,catalog,env); } catch(error) { assert(error.code===code,`${code}: ${error}`); return; }
    throw Error(`Expected ${code}`);
  };
  const single = f => ({apiVersion:1,id:'test.profile',version:1,features:[{id:f.id,version:f.version}]});
  const pair = catalog => ({apiVersion:1,id:'test.profile',version:1,features:catalog.map(f=>({id:f.id,version:f.version}))});
  const custom = id => ({...structuredClone(features[0]),id,bindings:[]});
  await check('FPX-01','immutable official profile catalog',()=>{
    assert(same(profiles,fixture.profiles)&&same(features,fixture.features),'fixture catalog drift');
    assert(Object.isFrozen(profiles.core)&&Object.isFrozen(features[0].ownership),'mutable profile');
    for(const p of Object.values(profiles)) { const prepared=prepare(p,features,environment); assert(prepared.registry.frozen,'registry not frozen'); assert(prepared.features.length===p.features.length,'missing preset feature'); }
  });
  await check('FPX-01','none invokes no optional loader',async()=>{
    let calls=0; const activation=new Activation(prepare(profiles.core,features,environment));
    assert(await activation.activate({'editac.slash':()=>{calls++;throw Error('disabled');}}),'baseline activation');
    activation.dispose();activation.dispose(); assert(calls===0&&activation.resourceCount===0,'baseline resource');
  });
  await check('FPX-01','each preset and feature independently',async()=>{
    for(const p of [...Object.values(profiles),...features.map(single)]) {
      const prepared=prepare(p,features,environment), activation=new Activation(prepared);
      let live=0,disposed=0;
      const loaders=Object.fromEntries(prepared.features.map(f=>[f.id,()=>{live++;return {dispose(){live--;disposed++;}};}]));
      assert(await activation.activate(loaders),'preset startup'); assert(live===prepared.features.length,'preset resources');
      activation.dispose();activation.dispose();assert(live===0&&disposed===prepared.features.length,'preset teardown');
    }
  });
  await check('FPX-02','production rejects pending features',()=>rejects(profiles['code-tools'],features,{...environment,allowContractFixtures:false},'pending-feature'));
  await check('FPX-02','duplicate catalog/profile identities',()=>{
    rejects(profiles.core,[features[0],features[0]],environment,'duplicate');
    rejects({...single(features[0]),features:[{id:features[0].id,version:1},{id:features[0].id,version:1}]},features,environment,'duplicate');
  });
  await check('FPX-02','versions schema capabilities permissions',()=>{
    rejects({...single(features[0]),features:[{id:features[0].id,version:2}]},features,environment,'incompatible-version');
    rejects(single(features[0]),features,{...environment,schema:'other'},'incompatible-schema');
    rejects(single(features[0]),features,{...environment,capabilities:[]},'missing-capability');
    const f={...custom('test.permission'),permissions:['asset-read']}; rejects(single(f),[f],environment,'missing-permission');
    assert(prepare(single(f),[f],{...environment,permissions:['asset-read']}).features.length===1,'explicit permission');
  });
  await check('FPX-02','missing incompatible cyclic dependencies and conflicts',()=>{
    const a=custom('test.a'),b=custom('test.b');a.requires=[{id:b.id,min:1,max:1}];
    rejects(single(a),[a,b],environment,'missing-dependency');
    b.version=2;rejects(pair([a,b]),[a,b],environment,'incompatible-dependency'); b.version=1;
    b.requires=[{id:a.id,min:1,max:1}];rejects(pair([a,b]),[a,b],environment,'dependency-cycle');b.requires=[];
    a.conflicts=[b.id];rejects(pair([a,b]),[a,b],environment,'conflict');
  });
  await check('FPX-02','malformed/accessor/callback data rejected without evaluation',()=>{
    let evaluated=0;const f=custom('test.accessor');Object.defineProperty(f,'owner',{enumerable:true,get(){evaluated++;return 'host';}});
    rejects(single(f),[f],environment,'invalid-data');assert(evaluated===0,'accessor executed');
    const bad={...custom('test.callback'),callback(){evaluated++;}};rejects(single(bad),[bad],environment,'invalid-data');
  });
  await check('FPX-02','required loaders validated before any activation',async()=>{
    const prepared=prepare(profiles['code-tools'],features,environment);let calls=0;
    const activation=new Activation(prepared);
    try { await activation.activate({[prepared.features[0].id]:()=>{calls++;return {dispose(){}};}});throw Error('missing loader accepted'); }
    catch(e) { assert(e.code==='missing-loader','missing-loader diagnosis'); }
    assert(calls===0,'partial activation');activation.dispose();
  });
  await check('FPX-02','owning data registry rejects incompatible descriptors atomically',()=>{
    const a=custom('test.a'),b=custom('test.b');
    a.definition={type:'custom.note',version:1,kind:'mark',attributes:{},content:{type:'text',maxUtf16:128},fallback:{type:'text',source:'content'}};
    const prepared=prepare(single(a),[a],environment);assert(prepared.registry.frozen&&prepared.registry.size===1,'registry admission');
    assert(prepared.registry.resolve('module:custom.note',[1,{}],'note'),'qualified descriptor');
    assert(!prepared.registry.resolve('module:custom.note',[99,{opaque:'retain'}],'source'),'future version interpreted');
    b.definition={...a.definition,version:2};rejects(pair([a,b]),[a,b],environment,'incompatible');
    assert(prepared.registry.resolve('module:custom.note',[1,{}],'note').definition.version===1,'prior registry changed');
  });
  await check('FPX-03','all legal registration/preset order permutations',()=>{
    for(const p of Object.values(profiles)) {
      const expected=prepare(p,features,environment);
      for(let i=0;i<features.length;i++) {
        const catalog=[...features.slice(i),...features.slice(0,i)].reverse();
        const result=prepare({...p,features:[...p.features].reverse()},catalog,environment);
        assert(same(result.bindings,expected.bindings)&&same(result.features,expected.features)&&same(result.profile,expected.profile),'order-dependent outcome');
      }
    }
  });
  await check('FPX-03','command keymap and input-rule priority/conflict/remap',()=>{
    for(const kind of ['command','keymap','input-rule']) {
      const a=custom('test.a'),b=custom('test.b');
      a.bindings=[{kind,key:'shared',command:'a',priority:1}]; b.bindings=[{kind,key:'shared',command:'b',priority:2}];
      const p=pair([a,b]); assert(prepare(p,[b,a],environment).bindings[0].feature===b.id,'priority');
      const remapped=prepare(p,[a,b],{...environment,remap:{[kind+':shared']:a.id}});
      assert(remapped.bindings[0].feature===a.id&&remapped.diagnostics[0].startsWith('remap '),'remap');
      b.bindings[0].priority=1;rejects(p,[a,b],environment,'binding-conflict');
      assert(prepare(p,[b,a],{...environment,remap:{[kind+':shared']:b.id}}).bindings[0].feature===b.id,'tie remap');
      rejects(p,[a,b],{...environment,remap:{unknown:a.id}},'invalid-remap');
    }
  });
  await check('FPX-03','dependency order canonical',()=>{
    const a=custom('test.a'),b=custom('test.b');a.requires=[{id:b.id,min:1,max:2}];
    assert(prepare(pair([a,b]),[a,b],environment).features.map(f=>f.id).join(',')==='test.b,test.a','topological order');
  });
  await check('FPX-06','activation rollback and throwing disposer isolation',async()=>{
    const prepared=prepare(profiles['code-tools'],features,environment);let live=0;
    const activation=new Activation(prepared);
    const loaders=Object.fromEntries(prepared.features.map((f,i)=>[f.id,()=>{
      if(i===1)throw Error('prepared failure');live++;return {dispose(){live--;throw Error('dispose');}};
    }]));
    assert(!await activation.activate(loaders)&&!activation.active&&live===0,'rollback');
    assert(activation.takeDiagnostics().length===2,'bounded diagnostics');
  });
  await check('FPX-07','timeout queue limit abort and late cleanup',async()=>{
    const activation=new Activation(prepare(single(features[0]),features,environment),10);let resolve,aborted=false,disposed=0;
    const pending=activation.activate({[features[0].id]:signal=>new Promise(done=>{resolve=done;signal.addEventListener('abort',()=>aborted=true);})});
    await Promise.resolve();
    assert((await activation.work(()=>1,v=>v===1,()=>'' )).status==='busy','queue bound');
    assert(!await pending&&!activation.active&&aborted,'deadline cancellation');
    resolve({dispose(){disposed++;}});await new Promise(r=>setTimeout(r,0));assert(disposed===1,'late loader leak');
  });
  await check('FPX-07','malformed stale and reentrant validation rejected',async()=>{
    const activation=new Activation(prepare(profiles.core,features,environment));let revision='a',resolve;
    assert((await activation.work(()=>({bad:true}),v=>typeof v==='number',()=>revision)).status==='failed','malformed');
    const pending=activation.work(()=>new Promise(done=>resolve=done),v=>typeof v==='number',()=>revision);
    await Promise.resolve();revision='b';resolve(1);assert((await pending).status==='stale','stale result');
    assert((await activation.work(()=>1,v=>{revision='c';return true;},()=>revision)).status==='stale','validation revision race');
    assert((await activation.work(()=>1,v=>{activation.dispose();return true;},()=>revision)).status==='cancelled','validation disposal race');
  });
  await check('FPX-08','repeated activation/disposal restores resource bounds',async()=>{
    let live=0,maximum=0;
    for(let i=0;i<20;i++) {
      const activation=new Activation(prepare(single(features[0]),features,environment));
      assert(await activation.activate({[features[0].id]:()=>{live++;maximum=Math.max(maximum,live);return {dispose(){live--;}};}}),'reload');
      assert(!await activation.activate({}),'duplicate mount');activation.dispose();activation.dispose();
      assert(live===0&&activation.resourceCount===0,'leak');
    }
    assert(maximum===1,'resource bound');
  });
  return cases;
}
