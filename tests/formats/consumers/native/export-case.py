"""Actual isolated captured-checkpoint exports and independent generated readers."""
import hashlib, importlib.util, json, os, pathlib, subprocess, sys, threading, time
OUT=pathlib.Path(os.environ['EDITAC_FORMATS_OUTPUT']).resolve()
p=json.loads((OUT/'prepared.json').read_text()); consumer=pathlib.Path(p['consumer'])
spec=importlib.util.spec_from_file_location('native_runner',consumer/'crates/editac-formats-native/runner.py')
r=importlib.util.module_from_spec(spec);sys.modules[spec.name]=r;spec.loader.exec_module(r)
records=[]
def digest(b):return hashlib.sha256(b).hexdigest()
def fixture(kind='supported'):
 b=p['binaries']['native-probe'];result=r._run(b['path'],b['sha256'],b'', 'export-fixture',(kind,))
 assert result.outcome['state']=='probe',result.outcome
 assert result.outcome['childExited'];return result.outcome['result']
def run(request,*,qualification=False,**kwargs):
 data=bytes(request) if isinstance(request,(bytes,bytearray)) else json.dumps(request,separators=(',',':')).encode()
 b=p['binaries']['native-probe' if qualification else 'native'];start=time.monotonic();result=r.run_export(b['path'],b['sha256'],data,**kwargs);o=result.outcome
 o['hostCallMs']=(time.monotonic()-start)*1000
 assert result.original==data and o['childExited'],o
 if o['state']!='passed':assert not o['outputAccepted'],o
 records.append(o);return o
def reject(o,code=None):
 assert not o['outputAccepted'] and o['state'] in ('rejected','unavailable'),o
 if code:assert o['code']==code,(code,o)
def read(data,name,kind,negative=False):
 path=OUT/(name+'.rtf');path.write_bytes(data)
 proc=subprocess.run(['/usr/bin/textutil','-convert','html','-stdout',str(path)],capture_output=True)
 (OUT/(name+'-reader.log')).write_bytes(proc.stderr);assert proc.returncode==0,proc.stderr
 html=OUT/(name+'.html');html.write_bytes(proc.stdout)
 oracle=subprocess.run(['python3',str(consumer/'tests/formats/rtf-reader.py'),str(html),kind],capture_output=True)
 (OUT/(name+'-oracle.log')).write_bytes(oracle.stdout+oracle.stderr)
 assert oracle.returncode==(1 if negative else 0),(name,oracle.stderr)
 return proc.stdout
case=sys.argv[1]
try:
 if case=='supported':
  request=fixture();a=run(request);b=run(request)
  for o in (a,b):
   assert o['state']=='passed',o
   v=o['result'];assert v['revision']==v['capturedRevision']==v['currentRevision'] and not v['laterEdit'],v
   assert v['liveUnchanged'] and v['reopen'] and v['activeJobs']==0 and v['networkCalls']==0 and v['assets']==0
   assert not any(d['lossy'] for d in v['report']['diagnostics'])
   assert {d['code'] for d in v['report']['diagnostics']}=={'STYLE_DEFAULTS','METADATA_DEFAULTS'}
   assert 0<v['peakRustHeapBytes']<=v['hardRustHeapBytes']==64*1024*1024
   assert o['peakObservedRssBytes']>0 and o['rssSamples']>0
  assert a['result']['artifact']==b['result']['artifact']
  read(bytes(a['result']['artifact']),'native-supported','supported')
  (OUT/'export-costs.json').write_text(json.dumps({'cold':a,'warm':b,'scope':'First/repeat fresh native public calls include binary pin hashing, bounded request/input FD, Python bootstrap, OS sandbox, checkpoint validation/Session reopen, immutable capture, complete writer/diagnostics/artifact JSON transfer, worker reaping and temporary teardown. Host Python startup additionally recorded by Node. Source fixture generation and independent reader excluded; no font/media reads in RTF. OS file caches not flushed; sampled RSS is not a hard process cap.'},indent=2)+'\n')
 elif case=='captured':
  q=fixture();q['laterText']='LATER_PRIVATE_EDIT';o=run(q,qualification=True);assert o['state']=='passed',o
  v=o['result'];assert v['laterEdit'] and v['revision']==v['capturedRevision']!=v['currentRevision']
  assert v['liveUnchanged'] and v['reopen'];assert b'LATER_PRIVATE_EDIT' not in bytes(v['artifact'])
  read(bytes(v['artifact']),'native-captured','supported')
 elif case=='marks':
  o=run(fixture('marks'));assert o['state']=='passed',o;read(bytes(o['result']['artifact']),'native-marks','marks')
 elif case=='diagnostics':
  q=fixture('loss');o=run(q);reject(o,'loss-approval-required')
  ds=o['result']['report']['diagnostics'];codes={d['code'] for d in ds}
  assert {'UNSUPPORTED_BLOCK_STYLE','UNSUPPORTED_CONTENT'}<=codes and any(c.startswith('UNSUPPORTED_MARK:') for c in codes),(codes,ds)
  assert all(d['location'] and isinstance(d['lossy'],bool) for d in ds)
  assert o['result']['liveUnchanged'] and o['result']['reopen'] and o['result']['activeJobs']==0
  q['approveLoss']=True;o=run(q);assert o['state']=='passed',o
  assert o['result']['report']['diagnostics']==ds
  data=bytes(o['result']['artifact']);path=OUT/'native-approved.rtf';path.write_bytes(data)
  reader=subprocess.run(['/usr/bin/textutil','-convert','txt','-stdout',str(path)],capture_output=True)
  assert reader.returncode==0 and b'codelink' in reader.stdout and b'x^2' in reader.stdout,reader
  assert b'example.invalid' not in data and b'\\object' not in data
  (OUT/'native-approved.txt').write_bytes(reader.stdout)
 elif case=='invalid':
  for data in (b'not json',b'{}',b'%PDF-1.7'):
   reject(run(data),'FORMAT_CHECKPOINT_INVALID')
  q=fixture()
  for key,value in [('writerId',0),('documentId','invalid'),('epoch','invalid'),('checkpointSha256','0'*64),('checkpoint',[0])]:
   bad=dict(q);bad[key]=value;reject(run(bad),'FORMAT_CHECKPOINT_INVALID')
  bad=dict(q);bad['checkpoint']=[0];bad['checkpointSha256']=digest(b'\0');reject(run(bad),'FORMAT_CHECKPOINT_INVALID')
 elif case=='frozen-input':
  q=fixture();data=bytearray(json.dumps(q).encode());original=bytes(data)
  event=threading.Event();start=r.subprocess.Popen
  def launched(*a,**kw):
   child=start(*a,**kw);data[:]=b'x'*len(data);event.set();return child
  r.subprocess.Popen=launched
  b=p['binaries']['native']
  try:
   result=r.run_export(b['path'],b['sha256'],data);o=result.outcome;records.append(o)
   assert result.original==original and o['childExited']
  finally:r.subprocess.Popen=start
  assert o['state']=='passed' and event.is_set() and o['originalSha256']==digest(original),o
  read(bytes(o['result']['artifact']),'native-frozen','supported')
 elif case=='limits':
  q=fixture();q['outputLimit']=8;o=run(q);reject(o,'output-budget');assert o['result']['liveUnchanged'] and o['result']['activeJobs']==0
  base=fixture()
  for limit in (0,-1,True,'8',2**63):
   bad=dict(base);bad['outputLimit']=limit;reject(run(bad),'FORMAT_OUTPUT_LIMIT_UNAVAILABLE')
  reject(run(fixture(),output_bytes=64),'FORMAT_OUTPUT_LIMIT')
  reject(run(b'x'*(r.MAX_INPUT+1)),'FORMAT_INPUT_LIMIT')
 elif case=='cancel':
  q=fixture();event=threading.Event();event.set();o=run(q,cancel=event);reject(o,'FORMAT_CANCELLED');assert o['executed']==0
  event.clear();timer=threading.Timer(0.05,event.set);timer.start()
  try:
   o=run(q,cancel=event);reject(o,'FORMAT_CANCELLED');assert o['executed']==1
  finally:timer.cancel();timer.join()
  event.clear();decode=r.json.loads
  def late(value):
   p=decode(value)
   if isinstance(p,dict) and 'artifact' in p:event.set()
   return p
  r.json.loads=late
  try:reject(run(q,cancel=event),'FORMAT_CANCELLED')
  finally:r.json.loads=decode
 elif case=='completion':
  q=fixture();decode=r.json.loads
  for key,value in [('artifact',[0]),('artifactSha256','0'*64),('sourceCheckpointSha256','0'*64),('revision','foreign'),('direction','import'),('activeJobs',1),('liveUnchanged',False),('reopen',False),('originalSha256','0'*64),('hardRustHeapBytes',0),('artifact',{'bad':1}),('artifact','bad'),('artifact',[-1]),('artifact',[True]),('liveUnchanged','yes'),('reopen',1),('report',None),('report',{'diagnostics':[]}),('currentRevision','foreign')]:
   def corrupt(raw):
    p=decode(raw)
    if isinstance(p,dict) and 'artifact' in p:p[key]=value
    return p
   r.json.loads=corrupt
   try:reject(run(q),'FORMAT_COMPLETION_INVALID')
   finally:r.json.loads=decode
  for value in ([], None, {'state':'passed'}):
   def malformed(raw):return value
   r.json.loads=malformed
   try:reject(run(q),'FORMAT_COMPLETION_INVALID')
   finally:r.json.loads=decode
 elif case=='unavailable':
  q=fixture();saved=r.SANDBOX;r.SANDBOX='/missing/native-sandbox'
  try:o=run(q);reject(o,'FORMAT_ISOLATION_UNAVAILABLE');assert o['executed']==0
  finally:r.SANDBOX=saved
  reject(run(q,wall_ms=4001),'FORMAT_RESOURCE_PROFILE_UNAVAILABLE')
  assert r._ACTIVE.acquire(False)
  try:reject(run(q),'FORMAT_BUSY')
  finally:r._ACTIVE.release()
 elif case=='reader-negatives':
  data=(OUT/'native-supported.rtf').read_bytes();read((consumer/'fixtures/formats/rtf/export/reader-probe.rtf').read_bytes(),'native-reference','probe')
  for name,src,dst in [('text',b'Unicode',b'Changed'),('surrogate',b'\\u-10179?\\u-8638?',b'?'),('mark',b'\\b ',b''),('cell',b'=1+1',b'=9'),('injection',b'\\\\object',b'\\object')]:
   assert src in data,name;read(data.replace(src,dst,1),'native-negative-'+name,'supported',True)
 elif case=='private':
  b=p['binaries']['native'];q=json.dumps(fixture()).encode();o=subprocess.run([b['path'],'rtf-export'],input=q,capture_output=True,env={'PATH':'/usr/bin:/bin'})
  assert o.returncode==78 and b'FORMAT_ISOLATION_UNAVAILABLE' in o.stderr and not o.stdout
 else:raise AssertionError(case)
finally:
 (OUT/('export-case-'+case+'.json')).write_text(json.dumps({'case':case,'records':records},indent=2)+'\n')
print(json.dumps({'case':case,'executed':len(records),'passed':True}))
