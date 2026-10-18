"""Native ODF1.3 export proof through exact packaged caller/Session/writer/AssetWork."""
import copy, hashlib, importlib.util, json, os, pathlib, subprocess, sys, threading, time
OUT=pathlib.Path(os.environ['EDITAC_FORMATS_OUTPUT']).resolve();p=json.loads((OUT/'prepared.json').read_text());consumer=pathlib.Path(p['consumer'])
def module(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m
r=module('ox_runner',consumer/'crates/editac-formats-native/runner.py');records=[]
fixture_data=json.loads((consumer/'tests/formats/consumers/odt-fixture.json').read_text())
def fixture(kind='odt'):
 b=p['binaries']['odt-probe'];v=r._run(b['path'],b['sha256'],b'','export-fixture',(kind,)).outcome
 assert v['state']=='probe',v
 q=v['result'];q.update(profile='edit-ac-odt-v1',approveLoss=False,approvedAssets=[dict(fixture_data['descriptor']['identity'],bytes=fixture_data['pixel'])]);return q
def run(q,qualification=False,**kwargs):
 data=bytes(q) if isinstance(q,(bytes,bytearray)) else json.dumps(q,separators=(',',':')).encode();b=p['binaries']['odt-probe' if qualification else 'odt-native'];start=time.monotonic();result=r.run_odt_export(b['path'],b['sha256'],data,**kwargs);o=result.outcome;o['hostCallMs']=(time.monotonic()-start)*1000
 assert result.original==data and o['childExited'];records.append(o);return o
def reject(o,code=None):
 assert o['state'] in ('rejected','unavailable') and not o['outputAccepted'],o
 if code:assert o['code']==code,(code,o)
def passed(o):
 assert o['state']=='passed' and o['outputAccepted'],o
 v=o['result'];assert v['liveUnchanged'] and v['reopen'] and v['activeJobs']==v['networkCalls']==0
 assert v['revision']==v['capturedRevision'] and v['sourceCheckpointSha256']
 assert 0<v['peakRustHeapBytes']<=r.RUST_HEAP and o['peakObservedRssBytes']>0 and o['rssSamples']>0
 ds=v['report']['diagnostics'];assert {d['code'] for d in ds}=={'PACKAGE_REGENERATED','STYLE_DEFAULTS','METADATA_DEFAULTS'} and len(ds)==3 and not any(d['lossy'] for d in ds),ds
 assert v['assets']==v['report']['assets']==1 and v['report']['originalBytes']==70
 assert v['report']['mediaWork']['pixels']==1 and v['report']['mediaWork']['decodeCalls']==1
 return v
case=sys.argv[1]
try:
 if case=='supported':
  q=fixture();a=run(q);b=run(q);va=passed(a);vb=passed(b);assert va['artifact']==vb['artifact'] and va['revision']==va['currentRevision']
  (OUT/'native-supported.odt').write_bytes(bytes(va['artifact']))
  (OUT/'odt-export-costs.json').write_text(json.dumps({'cold':a,'warm':b,'scope':'First/repeat fresh public native calls: executable hashing, immutable full checkpoint/approved-original input transport, Python bootstrap/sandbox, Session/store load/capture, authorized AssetWork original read/hash/media validation, writer/ZIP, complete artifact/report transfer and correlation, process reap/teardown. Caller envelope retained for recovery. Node command includes Python caller startup. Fixture/oracle excluded; OS caches not flushed, RSS sampling is not a hard OS allocation cap.'},indent=2)+'\n')
 elif case=='reader':
  assert os.environ.get('EDITAC_ODT_READER_PYTHON'),'explicit offline pinned reader required'
  proc=subprocess.run([os.environ['EDITAC_ODT_READER_PYTHON'],str(consumer/'tests/formats/consumers/native/odt-oracle.py'),str(OUT)],cwd=consumer,capture_output=True)
  (OUT/'odt-independent-reader.log').write_bytes(proc.stdout+proc.stderr);assert proc.returncode==0,proc.stderr.decode()
  oracle=json.loads(proc.stdout);assert oracle['passed']==9 and oracle['failed']==oracle['skipped']==0
 elif case=='captured':
  q=fixture();q['laterText']='LATER_PRIVATE_EDIT';o=run(q,qualification=True);v=passed(o);assert v['laterEdit'] and v['revision']!=v['currentRevision'] and b'LATER_PRIVATE_EDIT' not in bytes(v['artifact']);assert bytes(v['artifact'])==(OUT/'native-supported.odt').read_bytes()
  reject(run(q),'FORMAT_PROFILE_UNAVAILABLE')
 elif case=='frozen-input':
  q=fixture();data=bytearray(json.dumps(q).encode());original=bytes(data);start=r.subprocess.Popen;event=threading.Event()
  def launched(*a,**kw):
   child=start(*a,**kw);data[:]=b'x'*len(data);event.set();return child
  r.subprocess.Popen=launched;b=p['binaries']['odt-native']
  try:
   result=r.run_odt_export(b['path'],b['sha256'],data);records.append(result.outcome);assert result.original==original and event.is_set();passed(result.outcome)
  finally:r.subprocess.Popen=start
 elif case=='loss':
  q=fixture('odt-loss');a=run(q);reject(a,'loss-approval-required');ds=a['result']['report']['diagnostics'];assert {d['code'] for d in ds}=={'PACKAGE_REGENERATED','STYLE_DEFAULTS','METADATA_DEFAULTS','UNSUPPORTED_BLOCK_STYLE','UNSUPPORTED_CONTENT'},ds
  q['approveLoss']=True;b=run(q);assert b['state']=='passed' and b['result']['report']['diagnostics']==ds and b['result']['assets']==1 and b['result']['reopen']
  (OUT/'native-loss.odt').write_bytes(bytes(b['result']['artifact']))
 elif case=='assets':
  q=fixture();bad=copy.deepcopy(q);bad.pop('approvedAssets');o=run(bad);reject(o);assert o['code'].startswith('asset-read:') and o['result']['liveUnchanged'] and o['result']['reopen'] and o['result']['activeJobs']==0
  bad=copy.deepcopy(q);bad['approvedAssets'][0]['key']='sibling';reject(run(bad))
  bad=copy.deepcopy(q);bad['approvedAssets'][0]['bytes'][-1]^=1;reject(run(bad),'asset-identity-mismatch')
  bad=copy.deepcopy(q);bad['approvedAssets']*=2;reject(run(bad),'FORMAT_ASSET_CAPABILITY_INVALID')
  for probe in ('fail','cancel'):
   bad=dict(q,assetProbe=probe);o=run(bad,qualification=True);reject(o);assert o['result']['reopen'] and o['result']['liveUnchanged'] and o['result']['activeJobs']==0
   reject(run(bad),'FORMAT_PROFILE_UNAVAILABLE')
 elif case=='invalid':
  reject(run(b'not json'),'FORMAT_CHECKPOINT_INVALID');q=fixture()
  for k,v,code in [('profile','auto','FORMAT_PROFILE_UNAVAILABLE'),('writerId',True,'FORMAT_CHECKPOINT_INVALID'),('checkpointSha256','0'*64,'FORMAT_CHECKPOINT_INVALID'),('checkpoint',[0],'FORMAT_CHECKPOINT_INVALID'),('approveLoss','yes','FORMAT_REQUEST_INVALID'),('approvedAssets',True,'FORMAT_ASSET_CAPABILITY_INVALID')]:
   bad=dict(q);bad[k]=v;reject(run(bad),code)
 elif case=='limits':
  q=fixture();q['outputLimit']=8;o=run(q);reject(o,'xml-output-budget');assert o['result']['activeJobs']==0 and o['result']['reopen']
  reject(run(fixture(),output_bytes=64),'FORMAT_OUTPUT_LIMIT');reject(run(b'x'*(r.MAX_INPUT+1)),'FORMAT_INPUT_LIMIT');reject(run(fixture(),wall_ms=1),'FORMAT_DEADLINE')
 elif case=='cancel':
  q=fixture();e=threading.Event();e.set();reject(run(q,cancel=e),'FORMAT_CANCELLED');e.clear();timer=threading.Timer(.05,e.set);timer.start()
  try:reject(run(q,cancel=e),'FORMAT_CANCELLED')
  finally:timer.cancel();timer.join()
  e.clear();decode=r.json.loads
  def late(raw):
   v=decode(raw)
   if isinstance(v,dict) and 'artifact' in v:e.set()
   return v
  r.json.loads=late
  try:reject(run(q,cancel=e),'FORMAT_CANCELLED')
  finally:r.json.loads=decode
 elif case=='completion':
  q=fixture();decode=r.json.loads
  changes=[('artifact',[0]),('artifact',[True]),('artifactSha256','0'*64),('sourceCheckpointSha256','0'*64),('revision','foreign'),('currentRevision','foreign'),('profile','foreign'),('direction','import'),('reopen',False),('liveUnchanged',1),('activeJobs',1),('report',None),('originalSha256','0'*64),('assets',0),('networkCalls',1),('networkCalls',False)]
  for k,v in changes:
   def corrupt(raw):
    x=decode(raw)
    if isinstance(x,dict) and 'artifact' in x:x[k]=v
    return x
   r.json.loads=corrupt
   try:reject(run(q),'FORMAT_COMPLETION_INVALID')
   finally:r.json.loads=decode
  for k,v in [('assets',True),('originalBytes',-1),('mediaWork',{}),('diagnostics',[])]:
   def corrupt(raw):
    x=decode(raw)
    if isinstance(x,dict) and 'artifact' in x:x['report'][k]=v
    return x
   r.json.loads=corrupt
   try:reject(run(q),'FORMAT_COMPLETION_INVALID')
   finally:r.json.loads=decode
 elif case=='authority':
  q=fixture();saved=r.SANDBOX;r.SANDBOX='/missing/sandbox'
  try:reject(run(q),'FORMAT_ISOLATION_UNAVAILABLE')
  finally:r.SANDBOX=saved
  b=p['binaries']['odt-native'];v=subprocess.run([b['path'],'odt-export'],input=json.dumps(q).encode(),capture_output=True,env={'PATH':'/usr/bin:/bin'});assert v.returncode==78 and not v.stdout
  b=p['binaries']['native'];v=r.run_odt_export(b['path'],b['sha256'],json.dumps(q).encode()).outcome;reject(v,'FORMAT_PROFILE_UNAVAILABLE')
  assert r._ACTIVE.acquire(False)
  try:reject(run(q),'FORMAT_BUSY')
  finally:r._ACTIVE.release()
 else:raise AssertionError(case)
finally:(OUT/('odt-export-case-'+case+'.json')).write_text(json.dumps({'case':case,'records':records},indent=2)+'\n')
print(json.dumps({'case':case,'executed':len(records),'passed':True}))
