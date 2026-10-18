"""Actual optional native PDF boundary; readers inspect generated output only."""
import copy, hashlib, importlib.util, json, os, pathlib, subprocess, sys, threading, time
OUT=pathlib.Path(os.environ['EDITAC_FORMATS_OUTPUT']).resolve();p=json.loads((OUT/'prepared.json').read_text());consumer=pathlib.Path(p['consumer'])
def module(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m
r=module('px_runner',consumer/'crates/editac-formats-native/runner.py');records=[]
def fixture(kind='text'):
 if kind=='overflow':
  # A single real Session paragraph reaches pagination before the checkpoint
  # admission limit. Use the already qualified native text producer, not a
  # fabricated checkpoint or a second semantic model.
  source=b'{\\rtf1\\ansi '+b'\\line '.join(('Page overflow line %03d.'%n).encode() for n in range(200))+b'}'
  b=p['binaries']['pdf-native'];result=r.run(b['path'],b['sha256'],source);v=result.outcome
  assert result.original==source and v['state']=='passed' and v['outputAccepted'],v
  (OUT/'pdf-overflow.rtf').write_bytes(source)
  (OUT/'pdf-overflow-fixture.json').write_text(json.dumps(v,indent=2)+'\n')
  q={k:v['result'][k] for k in ['documentId','epoch','writerId','checkpoint','checkpointSha256']}
  q.update(profile='edit-ac-pdf-publication-v1',fontSet='noto-pinned-v1',approveLoss=False);return q
 b=p['binaries']['pdf-probe'];v=r._run(b['path'],b['sha256'],b'','export-fixture',('pdf-'+kind,)).outcome
 assert v['state']=='probe',v
 q=v['result'];q.update(profile='edit-ac-pdf-publication-v1',fontSet='noto-pinned-v1',approveLoss=False)
 if kind=='structure':q['approvedAssets']=[dict(host='local',key='pdf-panels',bytes=list((consumer/'fixtures/formats/pdf/export/panels.png').read_bytes()))]
 return q
def run(q,qualification=False,**kwargs):
 start=time.monotonic();data=bytes(q) if isinstance(q,(bytes,bytearray)) else json.dumps(q,separators=(',',':')).encode();b=p['binaries']['pdf-probe' if qualification else 'pdf-native'];result=r.run_pdf_export(b['path'],b['sha256'],data,**kwargs);o=result.outcome;o['hostCallMs']=(time.monotonic()-start)*1000
 assert result.original==data and o['childExited'];records.append(o);return o
def reject(o,code=None):
 assert o['state'] in ('rejected','unavailable') and not o['outputAccepted'],o
 if code:assert o['code']==code,(code,o)
 if 'result' in o:
  assert o['result']['liveUnchanged'] is True,o
  if 'activeJobs' in o['result']:assert o['result']['activeJobs']==0 and o['result']['reopen'],o
 return o
def passed(o,kind='text'):
 assert o['state']=='passed' and o['outputAccepted'],o
 v=o['result'];assert v['liveUnchanged'] and v['reopen'] and v['activeJobs']==v['networkCalls']==0
 assert v['revision']==v['capturedRevision'] and v['sourceCheckpointSha256']
 assert 0<v['peakRustHeapBytes']<=r.RUST_HEAP and o['peakObservedRssBytes']>0 and o['rssSamples']>0
 report=v['report'];ds=report['diagnostics'];expected={'LAYOUT_DEFAULTS'}|({'TABLE_LAYOUT_DEFAULTS'} if kind=='structure' else set())
 assert {d['code'] for d in ds}==expected and not any(d['lossy'] for d in ds),ds
 assert report['pages']>1 and report['shapedBytes']>0
 assert v['assets']==(1 if kind=='structure' else 0)
 if kind=='structure':assert report['pixels']==7200 and report['pngScanCalls']==6 and report['pngScanBytes']==21660 and report['images']==1 and report['cells']==18
 return v
case=sys.argv[1]
try:
 if case in ('text','rich','structure'):
  q=fixture(case);a=run(q);b=run(q);va=passed(a,case);vb=passed(b,case);assert va['artifact']==vb['artifact'] and va['revision']==va['currentRevision']
  folder=OUT/('pdf-'+case);folder.mkdir(exist_ok=True);(folder/(case+'-publication.pdf')).write_bytes(bytes(va['artifact']))
  (OUT/('pdf-'+case+'-costs.json')).write_text(json.dumps({'cold':a,'warm':b,'scope':'Sequential fresh public calls, OS cache uncontrolled. Caller checkpoint/approved-original envelope encoding, executable hashing/loading including embedded fonts, Python bootstrap/sandbox, shared Session/store restore/capture, AssetWork authorization/read/hash/PNG scan/decode, full shaping/layout/render, complete artifact/report transfer/correlation, process reap/teardown. Node command also includes fixture generation and Python caller startup; independent readers excluded. Rust requested heap cap excludes allocator metadata/mappings/stack/non-Rust allocation; whole-process RSS sampled, not a hard OS memory cap.'},indent=2)+'\n')
 elif case=='reader':
  assert os.environ.get('EDITAC_PDF_PYTHON'),'explicit pinned independent PDF reader required'
  for kind,negatives in [('text',5),('rich',4),('structure',6)]:
   folder=OUT/('pdf-'+kind);args=[os.environ['EDITAC_PDF_PYTHON'],str(consumer/('tests/formats/inspect-pdf-'+('export' if kind=='text' else kind)+'.py')),str(folder),str(consumer/('fixtures/formats/pdf/export/'+kind+'.json'))]
   if kind=='structure':args.append(str(consumer/'fixtures/formats/pdf/export/panels.png'))
   proc=subprocess.run(args,cwd=consumer,capture_output=True);(OUT/('pdf-'+kind+'-independent.log')).write_bytes(proc.stdout+proc.stderr);assert proc.returncode==0,proc.stderr.decode()
   oracle=json.loads((folder/('independent-inspection.json' if kind=='text' else kind+'-inspection.json')).read_text());assert len(oracle['rejectedMutations'])==negatives
   if kind=='text':
    proc=subprocess.run([os.environ['EDITAC_PDF_PYTHON'],str(consumer/'tests/formats/inspect-pdf-arabic.py'),str(folder),str(consumer/'fixtures/formats/pdf/export/arabic-glyphs.json')],cwd=consumer,capture_output=True);(OUT/'pdf-arabic-independent.log').write_bytes(proc.stdout+proc.stderr);assert proc.returncode==0,proc.stderr.decode()
 elif case=='captured':
  q=fixture();q['laterText']='LATER PRIVATE EDIT';o=run(q,qualification=True);v=passed(o);assert v['laterEdit'] and v['revision']!=v['currentRevision'];assert bytes(v['artifact'])==(OUT/'pdf-text/text-publication.pdf').read_bytes()
  reject(run(q),'FORMAT_PROFILE_UNAVAILABLE')
 elif case=='frozen-input':
  q=fixture();data=bytearray(json.dumps(q).encode());original=bytes(data);start=r.subprocess.Popen;event=threading.Event()
  def launched(*a,**kw):
   child=start(*a,**kw);data[:]=b'x'*len(data);event.set();return child
  r.subprocess.Popen=launched;b=p['binaries']['pdf-native']
  try:
   result=r.run_pdf_export(b['path'],b['sha256'],data);records.append(result.outcome);assert result.original==original and event.is_set();passed(result.outcome)
  finally:r.subprocess.Popen=start
 elif case=='loss':
  q=fixture('loss');a=reject(run(q),'SEMANTIC_RENDERING_UNIMPLEMENTED');ds=a['result']['report']['diagnostics'];assert {d['code'] for d in ds}=={'LAYOUT_DEFAULTS','BLOCK_RENDERING_UNIMPLEMENTED'} and sum(d['lossy'] for d in ds)==1,ds
  q['approveLoss']=True;b=reject(run(q),'SEMANTIC_RENDERING_UNIMPLEMENTED');assert b['result']['report']['diagnostics']==ds
 elif case=='assets':
  q=fixture('structure');bad=copy.deepcopy(q);bad.pop('approvedAssets');reject(run(bad));bad=copy.deepcopy(q);bad['approvedAssets'][0]['key']='sibling';reject(run(bad))
  bad=copy.deepcopy(q);bad['approvedAssets'][0]['bytes'][-1]^=1;reject(run(bad),'ASSET_IDENTITY_MISMATCH')
  bad=copy.deepcopy(q);bad['approvedAssets']*=2;reject(run(bad),'FORMAT_ASSET_CAPABILITY_INVALID')
  for probe in ('fail','cancel'):
   bad=dict(q,assetProbe=probe);reject(run(bad,qualification=True));reject(run(bad),'FORMAT_PROFILE_UNAVAILABLE')
  passed(run(q),'structure')
 elif case=='invalid':
  q=fixture()
  for k,v,code in [('profile','edit-ac-rtf-v1','FORMAT_PROFILE_UNAVAILABLE'),('documentId','bad','FORMAT_CHECKPOINT_INVALID'),('checkpointSha256','0'*64,'FORMAT_CHECKPOINT_INVALID'),('checkpoint',[0],'FORMAT_CHECKPOINT_INVALID'),('approveLoss','yes','FORMAT_REQUEST_INVALID'),('approvedAssets',True,'FORMAT_ASSET_CAPABILITY_INVALID'),('fontSet','host-fonts','FORMAT_FONT_SET_UNAVAILABLE')]:
   bad=dict(q);bad[k]=v;reject(run(bad),code)
  q.pop('fontSet');reject(run(q),'FORMAT_FONT_SET_UNAVAILABLE')
 elif case=='limits':
  q=fixture();q['outputLimit']=8;o=reject(run(q));assert o['code'].startswith('JOB:'),o
  reject(run(fixture(),output_bytes=64),'FORMAT_OUTPUT_LIMIT');reject(run(b'x'*(r.MAX_INPUT+1)),'FORMAT_INPUT_LIMIT');reject(run(fixture(),wall_ms=1),'FORMAT_DEADLINE')
  o=reject(run(fixture('overflow')));assert 'PAGE_LIMIT' in o['code'],o
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
  changes=[('artifact',[0]),('artifact',[True]),('artifactSha256','0'*64),('sourceCheckpointSha256','0'*64),('revision','foreign'),('currentRevision','foreign'),('profile','foreign'),('direction','import'),('reopen',False),('liveUnchanged',1),('activeJobs',1),('report',None),('originalSha256','0'*64),('assets',True),('networkCalls',1),('networkCalls',False)]
  for k,v in changes:
   def corrupt(raw):
    x=decode(raw)
    if isinstance(x,dict) and 'artifact' in x:x[k]=v
    return x
   r.json.loads=corrupt
   try:reject(run(q),'FORMAT_COMPLETION_INVALID')
   finally:r.json.loads=decode
  for k,v in [('pages',0),('pages',9),('originalBytes',-1),('fontBytesEmbedded',1),('fontSet','foreign'),('pixels',True),('diagnostics',[])]:
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
  b=p['binaries']['pdf-native'];v=subprocess.run([b['path'],'pdf-export'],input=json.dumps(q).encode(),capture_output=True,env={'PATH':'/usr/bin:/bin'});assert v.returncode==78 and not v.stdout
  b=p['binaries']['native'];reject(r.run_pdf_export(b['path'],b['sha256'],json.dumps(q).encode()).outcome,'FORMAT_PROFILE_UNAVAILABLE')
  assert r._ACTIVE.acquire(False)
  try:reject(run(q),'FORMAT_BUSY')
  finally:r._ACTIVE.release()
 else:raise AssertionError(case)
finally:(OUT/('pdf-export-case-'+case+'.json')).write_text(json.dumps({'case':case,'records':records},indent=2)+'\n')
print(json.dumps({'case':case,'executed':len(records),'passed':True}))
