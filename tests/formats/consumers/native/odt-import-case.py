"""Native ODT text consumer and explicit media adoption prerequisite evidence."""
import copy,hashlib,importlib.util,json,os,pathlib,subprocess,sys,threading,time,zipfile
OUT=pathlib.Path(os.environ['EDITAC_FORMATS_OUTPUT']).resolve();p=json.loads((OUT/'prepared.json').read_text());consumer=pathlib.Path(p['consumer'])
def module(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m
r=module('oi_runner',consumer/'crates/editac-formats-native/runner.py');oracle=module('oi_oracle',consumer/'tests/formats/consumers/native/odt-import-oracle.py');records=[]
fixtures=OUT/'odt-import-fixtures'
if not (fixtures/'manifest.json').exists():
 q=subprocess.run(['python3','tests/formats/consumers/odt-import-fixtures.py',str(fixtures)],cwd=consumer,capture_output=True);assert q.returncode==0,q.stderr
# Strip unused embedded PNG only from native text-only fixture variants.
if not (fixtures/'native-text-manifest.json').exists():
 pins={}
 for name in ('supported','loss','nodes','hostile'):
  path=fixtures/(name+'.odt');raw=path.read_bytes()
  if name=='supported':(fixtures/'orphan.odt').write_bytes(raw)
  import io
  result=io.BytesIO()
  with zipfile.ZipFile(io.BytesIO(raw)) as src,zipfile.ZipFile(result,'w') as dst:
   for info in src.infolist():
    if info.filename=='Pictures/pixel.png':continue
    data=src.read(info)
    if info.filename=='META-INF/manifest.xml':
     data=data.replace(b'<manifest:file-entry manifest:full-path="Pictures/pixel.png" manifest:media-type="image/png"/>',b'')
    dst.writestr(info,data)
  path.write_bytes(result.getvalue());pins[name]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size}
 (fixtures/'native-text-manifest.json').write_text(json.dumps(pins,indent=2)+'\n')
source=fixtures/'supported.odt';fixture=source.read_bytes()
def run(data=fixture,approve_loss=False,probe=None,**kwargs):
 b=p['binaries']['odt-probe' if probe else 'odt-native'];start=time.monotonic()
 result=r._run(b['path'],b['sha256'],data,'odt-import',('approve-loss' if approve_loss else 'strict',probe),**kwargs) if probe else r.run_odt_import(b['path'],b['sha256'],data,approve_loss=approve_loss,**kwargs)
 o=result.outcome;o['hostCallMs']=(time.monotonic()-start)*1000;assert result.original==bytes(data) and o['childExited'];records.append(o);return o
def reject(o,code=None):
 assert o['state'] in ('rejected','unavailable') and not o['outputAccepted'],o
 if code:assert o['code']==code,(code,o)
 if 'result' in o:assert o['result']['liveUnchanged'] is True,o
 return o

def passed(o):
 assert o['state']=='passed' and o['outputAccepted'],o
 assert o['peakObservedRssBytes']>0 and o['rssSamples']>0
 v=o['result'];assert 0<v['peakRustHeapBytes']<=r.RUST_HEAP;return v
case=sys.argv[1]
try:
 if case=='supported':
  a=run();b=run();oracle.inspect(passed(a),source);oracle.inspect(passed(b),source)
  (OUT/'native-odt-import-projection.json').write_text(json.dumps(a['result'],ensure_ascii=False,indent=2)+'\n')
  (OUT/'odt-import-costs.json').write_text(json.dumps({'cold':a,'warm':b,'scope':'First/repeat fresh isolated native calls: input copy/hash/transport, executable authentication, bootstrap/sandbox, inflate/XML/style/list/table mapper, new shared Session, one commit, undo/redo/reopen, checkpoint/report transfer, RSS sampling and child teardown. Python caller startup measured in command receipt. OS caches not flushed; in-memory store, no crash durability or native-media adoption claim.'},indent=2)+'\n')
 elif case=='oracle':
  v=json.loads((OUT/'native-odt-import-projection.json').read_text());oracle.inspect(v,source);names=oracle.negatives(v,source)
  (OUT/'odt-import-independent.json').write_text(json.dumps({'passed':1,'failed':0,'skipped':0,'negativeMutations':names,'oracle':'Independent hand-authored ODF XML and actual committed Session text/marks/list/table/history/reopen/source correlation'},indent=2)+'\n')
 elif case=='loss':
  orphan=reject(run((fixtures/'orphan.odt').read_bytes()),'LOSS_APPROVAL');assert [d['code'] for d in orphan['result']['report']['diagnostics']]==['UNIMPORTED_EMBEDDED_MEDIA']
  data=(fixtures/'loss.odt').read_bytes();a=reject(run(data),'LOSS_APPROVAL');ds=a['result']['report']['diagnostics'];assert ds and all(d['lossy'] and d['action'] and d['location'] for d in ds)
  b=passed(run(data,approve_loss=True));assert b['report']['diagnostics']==ds and b['lossApproved'] and b['updates']==b['historyGroups']==1
 elif case=='media':
  for name in ('media','media-loss'):
   data=(fixtures/(name+'.odt')).read_bytes()
   with zipfile.ZipFile(fixtures/(name+'.odt')) as z:pixel=z.read('Pictures/pixel.png')
   for approval in (False,True):
    o=reject(run(data,approve_loss=approval),'FORMAT_NATIVE_ASSET_ADOPTION_UNAVAILABLE');v=o['result'];assert v['activeJobs']==0 and v['report']['stagedBytes']==len(pixel) and len(v['mediaCandidates'])==1
    c=v['mediaCandidates'][0];assert bytes(c['bytes'])==pixel and c['sha256']==c['identity']['key']==hashlib.sha256(pixel).hexdigest()
 elif case=='invalid':
  for name in ('encrypted','corrupt','hostile','nodes'):reject(run((fixtures/(name+'.odt')).read_bytes()))
  reject(run(b'%PDF-1.7'),'FORMAT_EXPORT_ONLY');reject(run(b'not a package'))
  o=reject(run((fixtures/'remote.odt').read_bytes()));assert o['result']['report']['diagnostics'] and not o['outputAccepted']
 elif case=='atomic':
  for probe in ('cancel','denied','storage','stale'):
   o=reject(run(probe=probe),'JOB');assert o['result']['activeJobs']==0 and o['result']['location'].startswith('commit:') and o['result']['candidateDiscarded'] and o['result']['storeUnchanged'] and not o['result']['checkpointPublished']
  o=reject(run(probe='unknown'),'FORMAT_RECOVERY_REQUIRED');assert o['result']['candidateDiscarded'] and not o['result']['storeUnchanged'] and not o['result']['checkpointPublished']
  b=p['binaries']['odt-native'];o=r._run(b['path'],b['sha256'],fixture,'odt-import',('strict','cancel')).outcome;records.append(o);reject(o,'FORMAT_PROFILE_UNAVAILABLE')
 elif case=='limits':
  reject(run(b'x'*(r.MAX_INPUT+1)),'FORMAT_INPUT_LIMIT');reject(run(output_bytes=64),'FORMAT_OUTPUT_LIMIT')
  reject(run(wall_ms=4001),'FORMAT_RESOURCE_PROFILE_UNAVAILABLE')
 elif case=='cancel':
  e=threading.Event();e.set();reject(run(cancel=e),'FORMAT_CANCELLED');e.clear();decode=r.json.loads
  def late(raw):
   v=decode(raw);e.set();return v
  r.json.loads=late
  try:reject(run(cancel=e),'FORMAT_CANCELLED')
  finally:r.json.loads=decode
 elif case=='frozen':
  data=bytearray(fixture);launch=r.subprocess.Popen;e=threading.Event()
  def launched(*a,**kw):
   child=launch(*a,**kw);data[:]=b'x'*len(data);e.set();return child
  r.subprocess.Popen=launched
  try:
   b=p['binaries']['odt-native'];result=r.run_odt_import(b['path'],b['sha256'],data);records.append(result.outcome);assert result.original==fixture and e.is_set();oracle.inspect(passed(result.outcome),source)
  finally:r.subprocess.Popen=launch
 elif case=='completion':
  decode=r.json.loads
  for key,value in [('commits',True),('historyGroups',2),('updates',2),('activeJobs',1),('assets',1),('networkCalls',False),('undo',False),('redo',False),('reopen',False),('profile','foreign'),('originalSha256','0'*64),('checkpoint',[0]),('checkpointSha256','0'*64),('lossApproved',True),('report',None),('preparedBlocks',[])]:
   def corrupt(raw):
    v=decode(raw)
    if isinstance(v,dict) and v.get('state')=='passed':v[key]=value
    return v
   r.json.loads=corrupt
   try:reject(run(),'FORMAT_COMPLETION_INVALID')
   finally:r.json.loads=decode
 elif case=='authority':
  saved=r.SANDBOX;r.SANDBOX='/missing'
  try:reject(run(),'FORMAT_ISOLATION_UNAVAILABLE')
  finally:r.SANDBOX=saved
  b=p['binaries']['native'];reject(r.run_odt_import(b['path'],b['sha256'],fixture).outcome,'FORMAT_PROFILE_UNAVAILABLE')
  b=p['binaries']['odt-native'];q=subprocess.run([b['path'],'odt-import','strict'],input=fixture,capture_output=True,env={'PATH':'/usr/bin:/bin'});assert q.returncode==78 and not q.stdout
  reject(run(approve_loss='yes'),'FORMAT_REQUEST_INVALID')
 else:raise AssertionError(case)
finally:(OUT/('odt-import-case-'+case+'.json')).write_text(json.dumps({'case':case,'records':records},indent=2)+'\n')
print(json.dumps({'case':case,'executed':len(records),'passed':True}))
