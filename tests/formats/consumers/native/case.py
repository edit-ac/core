"""Real native runtime cases. Every result preserves original bytes; no providers."""
import hashlib, importlib.util, json, os, pathlib, subprocess, sys, tempfile, threading, time
OUT=pathlib.Path(os.environ['EDITAC_FORMATS_OUTPUT']).resolve()
prepared=json.loads((OUT/'prepared.json').read_text())
consumer=pathlib.Path(prepared['consumer'])
module_path=consumer/'crates/editac-formats-native/runner.py'
spec=importlib.util.spec_from_file_location('native_runner',module_path)
runner=importlib.util.module_from_spec(spec);sys.modules[spec.name]=runner;spec.loader.exec_module(runner)
fixture=(consumer/'fixtures/formats/rtf/supported.rtf').read_bytes()
records=[]
def run(data=fixture, probe=None, args=(), **kwargs):
    binary=prepared['binaries']['native-probe' if probe else 'native']
    start=time.monotonic()
    result=runner._run(binary['path'],binary['sha256'],data,probe,args,**kwargs) if probe else runner.run(binary['path'],binary['sha256'],data,**kwargs)
    outcome=result.outcome
    outcome['hostCallMs']=(time.monotonic()-start)*1000
    assert result.original==data, 'lost or changed original'
    assert outcome['childExited'], 'live child leaked'
    if outcome['state']!='passed':assert not outcome['outputAccepted']
    records.append(outcome)
    return outcome

def reject(r,code,executed=1):
    assert r['code']==code, (code,r)
    assert r['executed']==executed, r
    assert r['outputAccepted'] is False, r

case=sys.argv[1]
try:
    if case=='supported':
        cold=run();warm=run()
        for r in (cold,warm):
            assert r['state']=='passed',r
            p=r['result'];assert p['commits']==1 and p['activeJobs']==0 and p['assets']==0,p
            assert all(p[k] for k in ('undo','redo','reopen')),p
            assert p['originalSha256']==hashlib.sha256(fixture).hexdigest()
            assert hashlib.sha256(bytes(p['checkpoint'])).hexdigest()==p['checkpointSha256']
            blocks=p['preparedBlocks']
            text=[''.join(r['text'] for r in b['runs']) for b in blocks]
            assert text==['Hello bold both bold plain € é 🙂 {literal} \\ end','Second\ttab\nbreak','A\tB\né\t=1+1','Tail'],text
            committed=p['snapshotBlocks']
            assert [''.join(r['text'] for r in b['runs']) for b in committed]==text
            committed_both=next(r for r in committed[0]['runs'] if r['text']=='both')
            assert committed_both['attributes'].get('bold') is True and committed_both['attributes'].get('italic') is True,committed_both
            assert committed[2]['attributes']==blocks[2]['attributes'],(committed[2],blocks[2])
            marks=blocks[0]['runs'];both=next(r for r in marks if r['text']=='both');assert 'Bold' in both['marks'] and 'Italic' in both['marks'],both
            assert blocks[2]['attributes'][:2]==['module:editac.table',1],blocks[2]
            table=committed[2]['attributes'][2]
            assert table['source']=='A\tB\né\t=1+1' and table['alignments']==['none','none']
            assert table['rows']==[[[['A',[['bold']]]],[['B',[]]]],[[['é',[]]],[['=1+1',[]]]]],table
            assert p['text']==''.join(text),p['text']
            assert p['report']['diagnostics']==[]
            assert p['report']['scannedBytes']==len(fixture)
            assert p['report']['tokens']>80
            assert 0<p['peakRustHeapBytes']<=p['hardRustHeapBytes']==64*1024*1024
            assert r['rssSamples']>0 and r['peakObservedRssBytes']>0,r
            assert r['serializedBytes']<4*1024*1024
        assert cold['result']['documentId']!=warm['result']['documentId'],'reused new-session identity'
        (OUT/'costs.json').write_text(json.dumps({'cold':cold,'warm':warm,'scope':'Full isolated process call including binary hash, input FD, process/bootstrap, shared Session, parse/map/commit, history/reopen, checkpoint serialization/transfer and teardown; no fonts/assets/network in RTF profile; source/binary loading remains OS-cache-dependent. Host Python startup is additionally recorded by Node.'},indent=2)+'\n')
    elif case=='diagnostics':
        data=(consumer/'fixtures/formats/native/rtf-loss.rtf').read_bytes()
        r=run(data);reject(r,'LOSS_APPROVAL');assert r['result']['liveUnchanged'];report=r['result']['report']
        assert report['diagnostics'] and any('object' in d['control'] for d in report['diagnostics']),report
        assert all(d['action'] and d['code'] for d in report['diagnostics']),report
    elif case=='pdf':
        r=run(b'%PDF-1.7\nrenamed input');reject(r,'FORMAT_EXPORT_ONLY');assert r['result']['liveUnchanged']
    elif case=='malformed':
        r=run(b'{\\rtf1 missing end');assert r['state']=='rejected' and r['result']['liveUnchanged'],r
        assert r['code']=='GROUP_BALANCE',r
    elif case=='depth':
        r=run(b'{\\rtf1 '+b'{'*66+b'x'+b'}'*67);reject(r,'DEPTH_BUDGET');assert r['result']['liveUnchanged']
    elif case=='input':
        r=run(b'x'*(runner.MAX_INPUT+1));reject(r,'FORMAT_INPUT_LIMIT',0)
    elif case=='unavailable':
        saved=runner.SANDBOX;runner.SANDBOX='/missing/native-sandbox'
        try:reject(run(),'FORMAT_ISOLATION_UNAVAILABLE',0)
        finally:runner.SANDBOX=saved
        binary=prepared['binaries']['native']
        r=runner.run(binary['path'],'0'*64,fixture);assert r.original==fixture;reject(r.outcome,'FORMAT_ENGINE_UNAVAILABLE',0)
        records.append(r.outcome)
        reject(run(wall_ms=4001),'FORMAT_RESOURCE_PROFILE_UNAVAILABLE',0)
        reject(run(output_bytes=runner.MAX_OUTPUT+1),'FORMAT_RESOURCE_PROFILE_UNAVAILABLE',0)
    elif case=='authority':
        with tempfile.TemporaryDirectory(prefix='editac-native-denial-') as temp:
            marker=pathlib.Path(temp)/'private.txt';marker.write_bytes(b'host marker outside sandbox')
            for mode in ('read','write','network','child'):
                r=run(b'',probe=mode,args=(str(marker),) if mode in ('read','write') else ())
                assert r['state']=='probe' and r['result']['denied'],r
            assert marker.read_bytes()==b'host marker outside sandbox'
    elif case=='heap':
        r=run(b'',probe='heap');reject(r,'FORMAT_HEAP_LIMIT');assert 'memory allocation of' in r['stderr']
    elif case=='output':
        reject(run(output_bytes=64),'FORMAT_OUTPUT_LIMIT')
        reject(run(b'',probe='output',output_bytes=4096),'FORMAT_OUTPUT_LIMIT')
    elif case=='deadline':
        reject(run(b'',probe='spin',wall_ms=300),'FORMAT_DEADLINE')
    elif case=='cpu':
        reject(run(b'',probe='spin'),'FORMAT_CPU_LIMIT')
    elif case=='cancel':
        event=threading.Event();event.set();reject(run(cancel=event),'FORMAT_CANCELLED',0)
        event.clear();timer=threading.Timer(0.3,event.set);timer.start()
        try:reject(run(b'',probe='spin',cancel=event),'FORMAT_CANCELLED')
        finally:timer.cancel();timer.join()
    elif case=='late':
        event=threading.Event();decode=runner.json.loads
        def late(value):
            payload=decode(value);event.set();return payload
        runner.json.loads=late
        try:reject(run(cancel=event),'FORMAT_CANCELLED')
        finally:runner.json.loads=decode
    elif case=='completion':
        decode=runner.json.loads
        def corrupt(value):
            payload=decode(value);payload['checkpoint'][0]^=1;return payload
        runner.json.loads=corrupt
        try:reject(run(),'FORMAT_COMPLETION_INVALID')
        finally:runner.json.loads=decode
    elif case=='busy':
        assert runner._ACTIVE.acquire(False)
        try:reject(run(),'FORMAT_BUSY',0)
        finally:runner._ACTIVE.release()
    elif case=='private':
        binary=prepared['binaries']['native'];env={'PATH':'/usr/bin:/bin'}
        r=subprocess.run([binary['path'],'rtf-import'],input=fixture,capture_output=True,env=env)
        assert r.returncode==78 and b'FORMAT_ISOLATION_UNAVAILABLE' in r.stderr and not r.stdout
        records.append(dict(exit=r.returncode,privateWorkerRequiresRunner=True))
    else:raise AssertionError('unknown native case '+case)
finally:
    (OUT/('case-'+case+'.json')).write_text(json.dumps(dict(case=case,records=records),indent=2)+'\n')
print(json.dumps(dict(case=case,executed=len(records),passed=True)))
