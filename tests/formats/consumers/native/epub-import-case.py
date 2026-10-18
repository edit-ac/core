"""Native EPUB text consumer and explicit media adoption prerequisite evidence."""
import copy,hashlib,importlib.util,json,os,pathlib,subprocess,sys,threading,time,zipfile
OUT=pathlib.Path(os.environ['EDITAC_FORMATS_OUTPUT']).resolve();p=json.loads((OUT/'prepared.json').read_text());consumer=pathlib.Path(p['consumer'])
def module(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m
r=module('ei_runner',consumer/'crates/editac-formats-native/runner.py');oracle=module('ei_oracle',consumer/'tests/formats/consumers/native/epub-import-oracle.py');records=[]
fixtures=OUT/'epub-import-fixtures'
if not (fixtures/'manifest.json').exists():
 q=subprocess.run(['python3','tests/formats/consumers/epub-import-fixtures.py',str(fixtures)],cwd=consumer,capture_output=True);assert q.returncode==0,q.stderr
module('ei_fixtures',consumer/'tests/formats/consumers/native/epub-import-fixtures.py').create(fixtures)
source=fixtures/'text.epub';fixture=source.read_bytes()
def run(data=fixture,approve_loss=False,probe=None,**kwargs):
 b=p['binaries']['epub-import-probe' if probe else 'epub-import-native'];start=time.monotonic()
 result=r._run(b['path'],b['sha256'],data,'epub-import',('approve-loss' if approve_loss else 'strict',probe),**kwargs) if probe else r.run_epub_import(b['path'],b['sha256'],data,approve_loss=approve_loss,**kwargs)
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
  (OUT/'native-epub-import-projection.json').write_text(json.dumps(a['result'],ensure_ascii=False,indent=2)+'\n')
  (OUT/'epub-import-costs.json').write_text(json.dumps({'cold':a,'warm':b,'scope':'First/repeat fresh isolated native calls: input copy/hash/transport, executable authentication, bootstrap/sandbox, guarded EPUB inflate/XML/spine/nav/sanitized XHTML mapper, new shared Session, one commit, undo/redo/reopen, checkpoint/report transfer, RSS sampling and child teardown. Python caller startup measured in command receipt. OS caches not flushed; in-memory store, no crash durability or native-media adoption claim.'},indent=2)+'\n')
 elif case=='oracle':
  v=json.loads((OUT/'native-epub-import-projection.json').read_text());oracle.inspect(v,source);names=oracle.negatives(v,source)
  (OUT/'epub-import-independent.json').write_text(json.dumps({'passed':1,'failed':0,'skipped':0,'negativeMutations':names,'oracle':'Independent hand-authored EPUB OPF/spine/nav/XHTML and actual committed Session text/marks/list/history/reopen/source correlation'},indent=2)+'\n')
 elif case=='loss':
  for name in ('supported','remote','active','nav-remote'):
   data=(fixtures/(name+'.epub')).read_bytes();a=reject(run(data),'LOSS_APPROVAL');ds=a['result']['report']['diagnostics'];assert ds and any(d['lossy'] for d in ds) and all(d['action'] and d['location'] for d in ds)
   expected={'supported':['UNIMPORTED_PUBLICATION_RESOURCE'],'remote':['UNIMPORTED_PUBLICATION_RESOURCE','REMOTE_OR_UNSUPPORTED_IMAGE_INERT'],'active':['UNSUPPORTED_XHTML_CONTENT_INERT']*2+['UNSUPPORTED_ELEMENT']*3+['UNSUPPORTED_ATTRIBUTE'],'nav-remote':['UNSUPPORTED_NAVIGATION_TARGET']}
   assert sorted(d['code'] for d in ds)==sorted(expected[name]),(name,ds)
   b=passed(run(data,approve_loss=True));assert b['report']['diagnostics']==ds and b['lossApproved'] and b['updates']==b['historyGroups']==1
   assert 'forbidden script' not in b['text'] and 'private' not in b['text'] and b['assets']==b['networkCalls']==0
 elif case=='media':
  for name in ('media','media-loss'):
   data=(fixtures/(name+'.epub')).read_bytes()
   with zipfile.ZipFile(fixtures/(name+'.epub')) as z:pixel=z.read('EPUB/images/pixel.png')
   for approval in (False,True):
    o=reject(run(data,approve_loss=approval),'FORMAT_NATIVE_ASSET_ADOPTION_UNAVAILABLE');v=o['result'];assert v['activeJobs']==0 and v['report']['stagedBytes']==len(pixel) and len(v['mediaCandidates'])==1
    c=v['mediaCandidates'][0];assert bytes(c['bytes'])==pixel and c['sha256']==c['identity']['key']==hashlib.sha256(pixel).hexdigest()
 elif case=='invalid':
  for name,code in [('corrupt','INGRESS_Budget'),('hostile','INGRESS_Path'),('nodes','SAFE_HTML'),('encrypted','EPUB_DRM_OR_ENCRYPTION_UNSUPPORTED'),('fixed','EPUB_FIXED_LAYOUT_UNSUPPORTED')]:reject(run((fixtures/(name+'.epub')).read_bytes()),code)
  reject(run(b'%PDF-1.7'),'FORMAT_EXPORT_ONLY');reject(run(b'not a package'))
 elif case=='atomic':
  for probe in ('cancel','denied','storage','stale'):
   o=reject(run(probe=probe),'JOB');assert o['result']['activeJobs']==0 and o['result']['location'].startswith('commit:') and o['result']['candidateDiscarded'] and o['result']['storeUnchanged'] and not o['result']['checkpointPublished']
  o=reject(run(probe='unknown'),'FORMAT_RECOVERY_REQUIRED');assert o['result']['candidateDiscarded'] and not o['result']['storeUnchanged'] and not o['result']['checkpointPublished']
  b=p['binaries']['epub-import-native'];o=r._run(b['path'],b['sha256'],fixture,'epub-import',('strict','cancel')).outcome;records.append(o);reject(o,'FORMAT_PROFILE_UNAVAILABLE')
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
   b=p['binaries']['epub-import-native'];result=r.run_epub_import(b['path'],b['sha256'],data);records.append(result.outcome);assert result.original==fixture and e.is_set();oracle.inspect(passed(result.outcome),source)
  finally:r.subprocess.Popen=launch
 elif case=='completion':
  decode=r.json.loads
  for key,value in [('commits',True),('historyGroups',2),('updates',2),('activeJobs',1),('assets',1),('networkCalls',False),('undo',False),('redo',False),('reopen',False),('profile','foreign'),('originalSha256','0'*64),('checkpoint',[0]),('checkpointSha256','0'*64),('lossApproved',True),('report',None),('preparedBlocks',[]),('report',{'blocks':5,'stagedBytes':0,'diagnostics':[{}]}),('report',{'blocks':8,'stagedBytes':0,'diagnostics':[],'chapters':[],'navigation':[],'metadata':{}})]:
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
  b=p['binaries']['native'];reject(r.run_epub_import(b['path'],b['sha256'],fixture).outcome,'FORMAT_PROFILE_UNAVAILABLE')
  b=p['binaries']['epub-import-native'];q=subprocess.run([b['path'],'epub-import','strict'],input=fixture,capture_output=True,env={'PATH':'/usr/bin:/bin'});assert q.returncode==78 and not q.stdout
  reject(run(approve_loss='yes'),'FORMAT_REQUEST_INVALID')
 else:raise AssertionError(case)
finally:(OUT/('epub-import-case-'+case+'.json')).write_text(json.dumps({'case':case,'records':records},indent=2)+'\n')
print(json.dumps({'case':case,'executed':len(records),'passed':True}))
