import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandProfiles, hostProfiles, pendingOwners, portableCommandIds, firstPartyIds } from './command-inventory.mjs';

export function registerCommandMatrix({ probe, mount, snapshot, finish, frame }) {
  for(const mode of ['editable','readonly','denied','remote'])
  test(`MWX-C03 complete portable command map ${mode}`,()=>probe(`MWX-C03-portable-${mode}`,async(page,fact)=>{
    const baseline=await mount(page,{readOnly:mode==='readonly',deniedCommands:mode==='denied'?portableCommandIds:[]}),before=await snapshot(page);
    const rows=await page.evaluate(async({mode,ids})=>{
      const f=(window as any).inputFixture;
      const catalog=f.surface.commands.map(c=>({id:c.id,aliases:[...c.aliases]}));
      const tokens=[];const rows=[];
      for(const c of catalog)for(const name of [c.id,...c.aliases]){
        const token=f.surface.captureCommand(name);rows.push({id:c.id,name,captured:!!token,active:token?.active??false});if(token)tokens.push(token);
      }
      if(mode==='remote')await f.remote(0,0,'remote ');
      const stale=mode==='remote'?tokens.map(t=>({active:t.active,outcome:t.execute('prepared replacement')})):[];
      for(const token of tokens)token.dispose();
      return {catalog,rows,stale,unknown:!!f.surface.captureCommand('unknown-optional-command')};
    },{mode,ids:portableCommandIds});
    assert.deepEqual(rows.catalog.map(c=>c.id),portableCommandIds);
    assert.equal(rows.unknown,false);
    const allowed=mode==='editable'||mode==='remote';for(const row of rows.rows){assert.equal(row.captured,allowed,row.name);assert.equal(row.active,allowed,row.name);}
    const after=await snapshot(page);
    if(mode==='remote'){
      assert.equal(after.history.undoGroups,0);assert.equal(after.journal.length,1);assert.equal(after.patches.filter(p=>p.update).length,1);
      for(const stale of rows.stale){assert.equal(stale.active,false);assert.equal(stale.outcome.disposition,'rejected');}
      assert.equal(after.nodes[0].runs.map(r=>r.text).join(''),'remote alpha');
    }else assert.deepEqual(after,before);
    fact.applicability={mode,available:true,enabled:true,authorized:allowed,qualified:false,...rows};await finish(page,baseline,fact);
  }));
  test('MWX-C02 registry inventory separates contract fixtures and presenter qualification',()=>probe('MWX-C02-registry-inventory',async(page,fact)=>{
    const baseline=await mount(page,{facade:'disabled'}),before=await snapshot(page);
    const registry=await page.evaluate(async()=>{const {FIRST_PARTY_FEATURES}=await import('@edit-ac/core/extensions');const f=(window as any).inputFixture;
      return FIRST_PARTY_FEATURES.map(feature=>({id:feature.id,owner:feature.owner,registryQualification:feature.qualification,capabilities:feature.capabilities,
        enabled:false,authorized:false,portableQualified:false,bindings:feature.bindings.map(binding=>{const token=f.surface.captureCommand(binding.command);const portable=!!token;token?.dispose();return {...binding,portable};})}));});
    assert.deepEqual(registry.map(r=>r.id),firstPartyIds);
    assert.deepEqual(registry.filter(r=>r.registryQualification==='contract-fixture').map(r=>r.id),['editac.code','editac.pairs']);
    for(const r of registry)assert.ok(r.bindings.every(b=>!b.portable),'profile activation metadata is not a portable editor command');
    assert.deepEqual(await snapshot(page),before);fact.registry=registry;fact.pendingOwners=pendingOwners;await finish(page,baseline,fact);
  }));
  for (const profile of commandProfiles) for (const mode of ['editable','readonly','remote'])
  test(`MWX-C03 advertised ${profile.id} commands ${mode}`, () => probe(`MWX-C03-inventory-${profile.id}-${mode}`, async (page, fact) => {
    const baseline = await mount(page, { ...profile.options, readOnly: mode === 'readonly' });
    const before = await snapshot(page);
    const observed = await page.evaluate(async ({ id, selector, commands, derivedControls }) => {
      const f = (window as any).inputFixture;
      if (id === 'search') { f.surface.search.show(); f.surface.search.query.value = 'alpha'; await f.surface.search.scan(); }
      if (id === 'slash' && !f.surface.slash.control.disabled) f.surface.slash.control.click();
      if (id === 'table') document.querySelector<HTMLButtonElement>('[aria-label="Select cell row 1 column 1"]')!.click();
      const root = document.querySelector(selector)!;
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')].filter(b => commands.includes(b.textContent));
      // Inventory all action buttons, excluding independently named cell selectors
      // and menu dismissal. A new write action must be admitted explicitly.
      const advertised = [...root.querySelectorAll<HTMLButtonElement>('button')].map(b=>b.textContent)
        .filter(label=>!(derivedControls??[]).includes(label) && label !== 'Close commands');
      const derived=id==='table'?[...root.querySelectorAll<HTMLButtonElement>('button')].map(b=>b.textContent).filter(label=>(derivedControls??[]).includes(label)):[];
      const unknown = f.surface.captureCommand('unknown-mobile-optional-command');
      const rows = buttons.map(b=>({label:b.textContent,disabled:b.disabled}));
      unknown?.dispose();
      return { advertised, derived, rows, unknown:!!unknown };
    }, profile);
    if (!(profile.id === 'slash' && mode === 'readonly')) assert.deepEqual(observed.advertised, profile.commands);
    assert.deepEqual(observed.derived,profile.derivedControls??[]);
    assert.equal(observed.unknown, false);
    if (mode === 'readonly') {
      for (const row of observed.rows) if (!profile.writes || profile.writes.includes(row.label)) assert.equal(row.disabled, true, row.label);
      await page.evaluate(({ selector, commands }) => {
        for (const b of document.querySelector(selector)!.querySelectorAll<HTMLButtonElement>('button'))
          if (commands.includes(b.textContent)) b.click();
      }, { ...profile, commands: profile.writes ?? profile.commands });
    } else for (const row of observed.rows) assert.equal(row.disabled, false, row.label);
    assert.deepEqual(await snapshot(page), before, 'applicability/unknown/disabled actions never commit');
    if (profile.id === 'search') await page.evaluate(() => (window as any).inputFixture.surface.search.close());
    if (profile.id === 'slash') await page.evaluate(() => (window as any).inputFixture.surface.slash.dismiss());
    if (mode === 'remote') {
      await page.evaluate(async () => (window as any).inputFixture.remote(0,0,'remote ')); await frame(page);
      const after = await snapshot(page);
      assert.equal(after.history.undoGroups,before.history.undoGroups);
      assert.equal(after.journal.length,before.journal.length+1);
      assert.equal(after.patches.filter(p=>p.update).length,before.patches.filter(p=>p.update).length+1);
      const open = await page.evaluate(() => { const f=(window as any).inputFixture;return {search:f.surface.search?.open??false,slash:f.surface.slash?.open??false,references:f.surface.references?.open??false}; });
      assert.deepEqual(open,{search:false,slash:false,references:false});fact.remote=open;
    }
    fact.inventory={...profile,mode,available:true,enabled:true,authorized:mode==='readonly'?false:'local fixture context only',qualified:false,observed,pendingOwners};
    await finish(page,baseline,fact);
  }));
  for (const mode of ['ready','denied','denied-insert','unknown','rejected','delayed','revoked'])
  test(`MWX-C02 owning reference host ${mode}`, () => probe(`MWX-C02-reference-host-${mode}`,async(page,fact)=>{
    const baseline=await mount(page,{referenceHost:mode==='revoked'?'ready':mode}),before=await snapshot(page);
    const initial=await page.evaluate(()=>{const s=(window as any).referenceHostState;return {resolve:s.resolveCalls,catalog:s.catalogCalls,subscriptions:s.subscriptions};});
    assert.deepEqual(initial,{resolve:0,catalog:0,subscriptions:1},'mount never resolves or reads the catalog');
    await page.evaluate(()=> (window as any).inputFixture.surface.references.control.click());
    await page.waitForFunction(()=>{const f=(window as any).inputFixture,s=(window as any).referenceHostState;return s.mode==='delayed'?!!s.complete:f.surface.references.menu.getAttribute('aria-busy')==='false';});
    if(mode==='delayed') {
      await page.evaluate(async()=>{const f=(window as any).inputFixture;await f.remote(0,0,'remote ');});
      const remote=await snapshot(page);
      await page.evaluate(()=>{(window as any).referenceHostState.complete([{targetId:'ac://team-1/12345678-1234-4234-8234-123456789abc',label:'Prepared local target'}]);});
      await frame(page);assert.deepEqual(await snapshot(page),remote,'late host result does not mutate a changed target');
    } else {
      if(mode==='revoked') await page.evaluate(()=>{const s=(window as any).referenceHostState;s.mode='denied';for(const notify of s.listeners)notify();});
      await page.evaluate(()=> (window as any).inputFixture.surface.references.activate(0));
      const after=await snapshot(page);
      if(mode==='ready') {assert.equal(after.history.undoGroups,1);assert.equal(after.journal.length,1);assert.equal(after.patches.filter(p=>p.update).length,1);}
      else assert.deepEqual(after,before,'unsupported/denied/rejected/revoked host never mutates');
    }
    const host=await page.evaluate(()=>{const s=(window as any).referenceHostState,f=(window as any).inputFixture;return {mode:s.mode,resolve:s.resolveCalls,catalog:s.catalogCalls,subscriptions:s.subscriptions,status:f.surface.references.status.textContent,pending:s.signals.map(x=>x.aborted)};});
    assert.equal(host.resolve,mode==='denied'?0:1);
    fact.capability={...hostProfiles[0],authorized:mode==='ready',mode,initial,host};
    await finish(page,baseline,fact);
    assert.equal(await page.evaluate(()=>(window as any).referenceHostState.subscriptions),0,'host subscription released');
  }));
  test('MWX-C02 absent reference host rejects configuration without allocation',()=>probe('MWX-C02-reference-host-absent',async(page,fact)=>{
    const baseline=await mount(page,{facade:'disabled'}),before=await snapshot(page);
    const code=await page.evaluate(async()=>{const {References}=await import('/web/extensions/configuration.js');try{References.configure({host:undefined});return 'accepted';}catch(e){return e.code;}});
    assert.equal(code,'invalid-option');assert.deepEqual(await snapshot(page),before);fact.capability={available:false,enabled:false,authorized:false,qualified:false,fallback:'native-contenteditable',code};
    await page.keyboard.type('x');assert.equal((await page.evaluate(()=>(window as any).inputFixture.state())).dom,'alxpha');await finish(page,baseline,fact);
  }));
  test('MWX-C03 owning search permission rejects replacement at commit',()=>probe('MWX-C03-search-denied',async(page,fact)=>{
    const baseline=await mount(page,{searchAuthorization:'denied'}),before=await snapshot(page);
    await page.evaluate(async()=>{const p=(window as any).inputFixture.surface.search;p.show();p.query.value='alpha';p.replacement.value='changed';await p.scan();p.replace(false);p.replace(true);});
    await frame(page);assert.deepEqual(await snapshot(page),before);fact.capability={available:true,enabled:true,authorized:false,qualified:false,owner:'modules/search.ts',fallback:'source retained; native editing available'};await finish(page,baseline,fact);
  }));
}
