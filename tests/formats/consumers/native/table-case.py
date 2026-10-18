"""Actual isolated source-packaged native text-table consumer; deterministic only."""
import copy, csv, hashlib, importlib.util, io, json, os, pathlib, subprocess, sys, tempfile, threading, time
OUT=pathlib.Path(os.environ['EDITAC_FORMATS_OUTPUT']).resolve()
prepared=json.loads((OUT/'prepared.json').read_text()); consumer=pathlib.Path(prepared['consumer'])
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path); m=importlib.util.module_from_spec(spec);sys.modules[name]=m;spec.loader.exec_module(m);return m
runner=module('table_runner',consumer/'crates/editac-formats-native/runner.py')
oracle=module('table_oracle',consumer/'tests/formats/consumers/native/table-oracle.py')
D=dict(delimiter='comma',quote='double',escape='double',encoding='utf8',newline='lf',header='first-row',ragged='reject')
fixture='name,empty,formula\n"🙂 é","","=1+1"\n"a\nb","he said ""yes""",+SUM(A1)\n'.encode()
records=[]
def run(data=fixture,dialect=None,probe=None,args=(),**kwargs):
    data=bytes(data); d=D.copy() if dialect is None else dialect
    b=prepared['binaries']['native-probe' if probe else 'native']; start=time.monotonic()
    r=runner._run(b['path'],b['sha256'],data,probe,args,**kwargs) if probe else runner.run_table(b['path'],b['sha256'],data,dialect=d,**kwargs)
    o=r.outcome;o['hostCallMs']=(time.monotonic()-start)*1000
    assert r.original==data and o['childExited'],o
    if o['state']!='passed':assert not o['outputAccepted']
    records.append(o);return o

def passed(r,data=fixture,d=D):
    assert r['state']=='passed',r
    assert oracle.inspect(r['result'],data,d)
    assert r['rssSamples']>0 and r['peakObservedRssBytes']>0
    assert 0<r['result']['peakRustHeapBytes']<=runner.RUST_HEAP

def reject(r,code,n=1):
    assert r['code']==code and r['executed']==n and not r['outputAccepted'],(code,r)
    if n and 'result' in r:assert r['result']['liveUnchanged'] is True
case=sys.argv[1]
try:
    if case=='csv':
        for _ in range(2):passed(run())
    elif case=='tsv':
        data=(consumer/'fixtures/formats/table-text/quoted.tsv').read_bytes();d=D|dict(delimiter='tab',newline='crlf')
        for _ in range(2):passed(run(data,d),data,d)
    elif case=='dialects':
        for delimiter in ('comma','tab'):
            for newline in ('lf','crlf'):
                for header in ('none','first-row'):
                    for encoding in ('utf8','utf8-bom'):
                        d=D|dict(delimiter=delimiter,newline=newline,header=header,encoding=encoding)
                        stream=io.StringIO(newline='');csv.writer(stream,delimiter=',' if delimiter=='comma' else '\t',lineterminator='\n' if newline=='lf' else '\r\n').writerows([['0','🙂',''],['@cmd','\t tab','-42']])
                        data=stream.getvalue().encode();data=(b'\xef\xbb\xbf'+data) if encoding=='utf8-bom' else data
                        passed(run(data,d),data,d)
    elif case=='invalid-dialect':
        for key in D:
            d=D.copy();del d[key];reject(run(dialect=d),'FORMAT_DIALECT_REQUIRED',0)
            reject(run(dialect=D|{key:'auto'}),'FORMAT_DIALECT_REQUIRED',0)
        for d in (None,{},D|dict(extra=True)):
            if d is None:
                b=prepared['binaries']['native'];r=runner.run_table(b['path'],b['sha256'],fixture,dialect=None);records.append(r.outcome);reject(r.outcome,'FORMAT_DIALECT_REQUIRED',0)
            else:reject(run(dialect=d),'FORMAT_DIALECT_REQUIRED',0)
    elif case=='malformed':
        for data,code in [(b'a,b\nc','RAGGED_ROW'),(b'"x','UNCLOSED_QUOTE'),(b'a\xff,b','UTF8'),(b'"a\rb",c','SHARED_CELL_CR_UNSUPPORTED')]:
            reject(run(data),code)
        reject(run(b'%PDF-1.7'),'FORMAT_EXPORT_ONLY')
    elif case=='limits':
        for data in (b'a,b\n'*129,','.join(['a']*33).encode(),('a'*8193+',b').encode()):
            r=run(data);assert r['state']=='rejected' and r['result']['liveUnchanged'],r
        reject(run(b'x'*(runner.MAX_INPUT+1)),'FORMAT_INPUT_LIMIT',0)
        reject(run(output_bytes=64),'FORMAT_OUTPUT_LIMIT')
        reject(run(b'',probe='heap'),'FORMAT_HEAP_LIMIT')
    elif case=='cancel':
        event=threading.Event();event.set();reject(run(cancel=event),'FORMAT_CANCELLED',0)
        event.clear();timer=threading.Timer(.3,event.set);timer.start()
        try:reject(run(b'',probe='spin',cancel=event),'FORMAT_CANCELLED')
        finally:timer.cancel();timer.join()
        decode=runner.json.loads
        def late(raw):
            p=decode(raw);event.set();return p
        event.clear();runner.json.loads=late
        try:reject(run(cancel=event),'FORMAT_CANCELLED')
        finally:runner.json.loads=decode
    elif case=='deadline':reject(run(b'',probe='spin',wall_ms=300),'FORMAT_DEADLINE')
    elif case=='authority':
        with tempfile.TemporaryDirectory(prefix='cnv-table-') as t:
            marker=pathlib.Path(t)/'private';marker.write_bytes(b'preserve me')
            for mode in ('read','write','network','child'):
                r=run(b'',probe=mode,args=(str(marker),) if mode in ('read','write') else ());assert r['state']=='probe' and r['result']['denied'],r
            assert marker.read_bytes()==b'preserve me'
    elif case=='unavailable':
        sandbox=runner.SANDBOX;runner.SANDBOX='/missing'
        try:reject(run(),'FORMAT_ISOLATION_UNAVAILABLE',0)
        finally:runner.SANDBOX=sandbox
        reject(run(wall_ms=4001),'FORMAT_RESOURCE_PROFILE_UNAVAILABLE',0)
        reject(run(output_bytes=runner.MAX_OUTPUT+1),'FORMAT_RESOURCE_PROFILE_UNAVAILABLE',0)
        assert runner._ACTIVE.acquire(False)
        try:reject(run(),'FORMAT_BUSY',0)
        finally:runner._ACTIVE.release()
    elif case=='completion':
        decode=runner.json.loads
        mutations=[lambda p:p.update(profile='wrong'),lambda p:p.update(originalSha256='0'*64),lambda p:p['checkpoint'].__setitem__(0,p['checkpoint'][0]^1),lambda p:p.update(dialect=['lf','utf8','none']),lambda p:p.update(commits=2),lambda p:p.update(activeJobs=1),lambda p:p.update(reopen=False),lambda p:p['report'].update(cells=0),lambda p:p['report'].update(scannedBytes=0),lambda p:p['report'].update(diagnostics=[{'code':'omitted'}]),lambda p:p['report'].update(bomRemoved=True),lambda p:p.update(hardRustHeapBytes=0)]
        for mutate in mutations:
            def corrupt(raw):
                p=decode(raw);mutate(p);return p
            runner.json.loads=corrupt
            try:reject(run(),'FORMAT_COMPLETION_INVALID')
            finally:runner.json.loads=decode
    elif case=='oracle-negatives':
        r=run();passed(r);p=r['result']
        def table(p):return next(b['attributes'][2] for b in p['snapshotBlocks'] if b['attributes'] and b['attributes'][0]=='module:editac.table')
        mutations=[lambda p:table(p)['rows'][1][0]['paragraphs'][0]['runs'][0].__setitem__(0,'changed'),lambda p:table(p)['rows'][0][0].update(header=False),lambda p:table(p).update(source='lost'),lambda p:table(p)['rows'].pop(),lambda p:table(p)['rows'][0][0].update(rowSpan=2),lambda p:p['report'].update(utf16Units=0),lambda p:p['report'].update(headerRows=0),lambda p:p['report'].update(diagnostics=[{'code':'lost'}]),lambda p:p.update(originalSha256='0'*64),lambda p:p.update(text='normalized')]
        for mutate in mutations:
            q=copy.deepcopy(p);mutate(q)
            try:oracle.inspect(q,fixture,D)
            except AssertionError:continue
            raise AssertionError('independent oracle accepted mutation')
        r['independentNegativeMutations']=len(mutations)
    elif case=='private':
        b=prepared['binaries']['native'];r=subprocess.run([b['path'],'csv-import','lf','utf8','none'],input=fixture,capture_output=True,env={'PATH':'/usr/bin:/bin'})
        assert r.returncode==78 and b'FORMAT_ISOLATION_UNAVAILABLE' in r.stderr and not r.stdout
        records.append(dict(exit=78,privateWorkerRequiresRunner=True))
    else:raise AssertionError('unknown case '+case)
finally:
    (OUT/('table-'+case+'.json')).write_text(json.dumps(dict(case=case,records=records),indent=2)+'\n')
print(json.dumps(dict(case=case,executed=len(records),passed=True)))
