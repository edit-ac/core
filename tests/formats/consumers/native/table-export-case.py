"""Actual native selected-table export; immutable package, independent cells, safety."""
import copy, hashlib, importlib.util, json, os, pathlib, subprocess, sys, threading, time
OUT=pathlib.Path(os.environ['EDITAC_FORMATS_OUTPUT']).resolve();p=json.loads((OUT/'prepared.json').read_text());consumer=pathlib.Path(p['consumer'])
def module(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m
r=module('tx_runner',consumer/'crates/editac-formats-native/runner.py');oracle=module('tx_oracle',consumer/'tests/formats/consumers/native/table-export-oracle.py');records=[]
def fixture(kind='table'):
 b=p['binaries']['native-probe'];v=r._run(b['path'],b['sha256'],b'','export-fixture',(kind,)).outcome
 assert v['state']=='probe',v
 q=v['result'];q.update(profile='edit-ac-csv-v1',newline='lf',approveLoss=True);return q
def run(q,qualification=False,**kwargs):
 data=bytes(q) if isinstance(q,(bytes,bytearray)) else json.dumps(q,separators=(',',':')).encode();b=p['binaries']['native-probe' if qualification else 'native'];start=time.monotonic();result=r.run_table_export(b['path'],b['sha256'],data,**kwargs);o=result.outcome;o['hostCallMs']=(time.monotonic()-start)*1000
 assert result.original==data and o['childExited'];records.append(o);return o
def reject(o,code):
 assert o['state'] in ('rejected','unavailable') and not o['outputAccepted'] and o['code']==code,(code,o)
def passed(o,q):
 assert o['state']=='passed',o
 assert oracle.inspect(o['result'],q);assert o['peakObservedRssBytes']>0 and o['rssSamples']>0
 assert 0<o['result']['peakRustHeapBytes']<=r.RUST_HEAP
case=sys.argv[1]
try:
 if case=='dialects':
  for format in ('csv','tsv'):
   for safe in ('','-spreadsheet-safe'):
    for newline in ('lf','crlf'):
     q=fixture();q.update(profile='edit-ac-'+format+safe+'-v1',newline=newline)
     a=run(q);b=run(q);passed(a,q);passed(b,q);assert a['result']['artifact']==b['result']['artifact']
     (OUT/('selected-'+format+safe+'-'+newline+'.'+format)).write_bytes(bytes(a['result']['artifact']))
  (OUT/'table-export-costs.json').write_text(json.dumps({'cold':records[0],'warm':records[1],'scope':'Full fresh public call: executable hashing, input freeze, sandbox/bootstrap, Session/checkpoint load, revision capture, selected-table writer/report, artifact transfer, correlation/hash validation, reaping/teardown. Independent oracle/fixture excluded; OS caches not flushed. Python startup in Node command receipt. Sampled process RSS is not a hard process cap.'},indent=2)+'\n')
 elif case=='selection':
  q=fixture()
  for value,code in [(None,'explicit-table-selection-required'),('', 'explicit-table-selection-required'),('missing','selected-table-not-captured'),(True,'FORMAT_SELECTION_INVALID')]:
   bad=dict(q)
   if value is None:bad.pop('selectedTable')
   else:bad['selectedTable']=value
   reject(run(bad),code)
  bad=dict(q);bad['selectedTable']=q['nonTableBlock'];reject(run(bad),'selected-target-not-table')
  multi=fixture('table-multiple');multi.pop('selectedTable');reject(run(multi),'explicit-table-selection-required')
 elif case=='frozen-input':
  q=fixture();data=bytearray(json.dumps(q).encode());original=bytes(data);start=r.subprocess.Popen;event=threading.Event()
  def launched(*a,**kw):
   child=start(*a,**kw);data[:]=b'x'*len(data);event.set();return child
  r.subprocess.Popen=launched;b=p['binaries']['native']
  try:
   result=r.run_table_export(b['path'],b['sha256'],data);o=result.outcome;records.append(o)
   assert result.original==original and event.is_set();passed(o,q)
  finally:r.subprocess.Popen=start
 elif case=='loss':
  q=fixture();q['approveLoss']=False;o=run(q);reject(o,'loss-approval-required');assert o['result']['reopen'] and o['result']['liveUnchanged'] and o['result']['activeJobs']==0
  q['approveLoss']=True;a=run(q);passed(a,q);assert a['result']['report']['diagnostics']==o['result']['report']['diagnostics']
 elif case=='captured':
  q=fixture();q['laterText']='LATER_PRIVATE_EDIT';o=run(q,qualification=True);passed(o,q);v=o['result'];assert v['revision']==v['capturedRevision']!=v['currentRevision'] and v['laterEdit'];assert b'LATER_PRIVATE_EDIT' not in bytes(v['artifact'])
  reject(run(q),'FORMAT_PROFILE_UNAVAILABLE')
 elif case=='invalid':
  reject(run(b'{}'),'FORMAT_PROFILE_UNAVAILABLE')
  for q in (b'not json',b'%PDF'):reject(run(q),'FORMAT_CHECKPOINT_INVALID')
  q=fixture()
  for k,v,code in [('profile','auto','FORMAT_PROFILE_UNAVAILABLE'),('newline','auto','FORMAT_DIALECT_REQUIRED'),('writerId',True,'FORMAT_CHECKPOINT_INVALID'),('checkpointSha256','0'*64,'FORMAT_CHECKPOINT_INVALID'),('checkpoint',[0],'FORMAT_CHECKPOINT_INVALID'),('approveLoss','yes','FORMAT_REQUEST_INVALID')]:
   bad=dict(q);bad[k]=v;reject(run(bad),code)
 elif case=='limits':
  q=fixture();q['outputLimit']=8;o=run(q);reject(o,'output-budget');assert o['result']['activeJobs']==0 and o['result']['reopen']
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
  changes=[('artifact',[0]),('artifact',[True]),('artifactSha256','0'*64),('sourceCheckpointSha256','0'*64),('revision','foreign'),('currentRevision','foreign'),('profile','foreign'),('direction','import'),('reopen',False),('liveUnchanged',1),('activeJobs',1),('report',None),('originalSha256','0'*64)]
  for k,v in changes:
   def corrupt(raw):
    x=decode(raw)
    if isinstance(x,dict) and 'artifact' in x:x[k]=v
    return x
   r.json.loads=corrupt
   try:reject(run(q),'FORMAT_COMPLETION_INVALID')
   finally:r.json.loads=decode
  for k,v in [('cells',11),('rows',True),('transformedCells',1),('diagnostics',[])]:
   def corrupt(raw):
    x=decode(raw)
    if isinstance(x,dict) and 'artifact' in x:x['report'][k]=v
    return x
   r.json.loads=corrupt
   try:reject(run(q),'FORMAT_COMPLETION_INVALID')
   finally:r.json.loads=decode
 elif case=='oracle-negatives':
  q=fixture();o=run(q);passed(o,q);base=o['result'];negatives=[]
  for src,dst in [(b'=1+1',b'=9'),('🙂'.encode(),b'?'),(b'""yes""',b'yes'),(b'""\n',b'"lost"\n')]:
   assert src in bytes(base['artifact']);v=copy.deepcopy(base);v['artifact']=list(bytes(v['artifact']).replace(src,dst,1));negatives.append(v)
  for k,v in [('cells',11),('transformedCells',1),('diagnostics',[])]:
   bad=copy.deepcopy(base);bad['report'][k]=v;negatives.append(bad)
  for bad in negatives:
   try:oracle.inspect(bad,q)
   except AssertionError:pass
   else:raise AssertionError('oracle accepted corrupted generated artifact/report')
 elif case=='authority':
  q=fixture();saved=r.SANDBOX;r.SANDBOX='/missing/sandbox'
  try:reject(run(q),'FORMAT_ISOLATION_UNAVAILABLE')
  finally:r.SANDBOX=saved
  b=p['binaries']['native'];v=subprocess.run([b['path'],'table-export'],input=json.dumps(q).encode(),capture_output=True,env={'PATH':'/usr/bin:/bin'});assert v.returncode==78 and not v.stdout
  assert r._ACTIVE.acquire(False)
  try:reject(run(q),'FORMAT_BUSY')
  finally:r._ACTIVE.release()
 else:raise AssertionError(case)
finally:(OUT/('table-export-case-'+case+'.json')).write_text(json.dumps({'case':case,'records':records},indent=2)+'\n')
print(json.dumps({'case':case,'executed':len(records),'passed':True}))
