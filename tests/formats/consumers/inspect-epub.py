"""Independent EbookLib/lxml oracle for generated browser EPUB, source fixture only."""
import hashlib, importlib.util, importlib.metadata, io, json, pathlib, sys, zipfile
# Adjacent inspect.py must not shadow stdlib inspect in EbookLib.
sys.path=[p for p in sys.path if pathlib.Path(p or '.').resolve()!=pathlib.Path(__file__).resolve().parent]
root=pathlib.Path.cwd();out=pathlib.Path(sys.argv[1])
spec=importlib.util.spec_from_file_location('epub_oracle',root/'tests/formats/inspect-epub-export.py');oracle=importlib.util.module_from_spec(spec);spec.loader.exec_module(oracle)
assert {p:importlib.metadata.version(p) for p in ['EbookLib','lxml','six']}=={'EbookLib':'0.20','lxml':'6.0.2','six':'1.17.0'}
f=json.loads((root/'tests/formats/consumers/epub-fixture.json').read_text())
def runs(rs):return [{'text':r['text'],'marks':[[m['mark'].title(),m.get('href')] for m in r['marks']]} for r in rs]
expected=[]
for b in f['blocks']:
 a=b.get('attributes') or {};kind=a.get('type')
 if kind=='content':
  t=a['tuple'];v=t[2]
  if t[0]=='module:editac.asset':
   m=v['metadata'];expected.append({'kind':'image','alt':m['alt'],'caption':m['caption'],'hash':hashlib.sha256(bytes(f['pixel'])).hexdigest(),'width':m['width'],'height':m['height']})
  elif t[0]=='module:editac.table':expected.append({'kind':'table','rows':[[[{'text':s,'marks':[[m.title(),None] for m in ms]} for s,ms in c] for c in row] for row in v['rows']],'alignments':['start' if a=='none' else a for a in v['alignments']]})
  else:raise AssertionError(t[0])
 else:expected.append({'kind':'h'+str(a['level']) if kind=='heading' else 'p','runs':runs(b['runs']),'lists':[['ol',c['style']['start']] if c['style']['type']=='ordered' else ['ul',1] for c in b.get('containers',[])]})
data=(out/'browser-supported.epub').read_bytes();result=oracle.verify(data,expected);assert result['chapters']==2
with zipfile.ZipFile(io.BytesIO(data)) as z:
 chapter=next(n for n in z.namelist() if n.startswith('EPUB/chapter-') and b'<strong>' in z.read(n));image=next(n for n in z.namelist() if n.endswith('.png'))
mutations=[('text',chapter,lambda b:b.replace(b'Cell A',b'Cell X')),('mark',chapter,lambda b:b.replace(b'<strong>',b'<em>').replace(b'</strong>',b'</em>')),('spine','EPUB/package.opf',lambda b:b.replace(b'<itemref idref="c0"/><itemref idref="c1"/>',b'<itemref idref="c1"/><itemref idref="c0"/>')),('toc','EPUB/nav.xhtml',lambda b:b.replace(b'chapter-0.xhtml',b'chapter-99.xhtml')),('image',image,lambda b:b[:-1]+bytes([b[-1]^1])),('active',chapter,lambda b:b.replace(b'</body>',b'<script>evil()</script></body>')),('metadata','EPUB/package.opf',lambda b:b.replace(b'>und<',b'>en<')),('remote',chapter,lambda b:b.replace(b'src="media/',b'src="https://evil.test/')),('alt',chapter,lambda b:b.replace(b'alt="Original',b'alt="Changed'))]
negatives=[]
for name,path,transform in mutations:
 changed=oracle.mutate(data,path,transform);assert changed!=data,name
 try:oracle.verify(changed,expected)
 except (AssertionError,KeyError,oracle.E.XMLSyntaxError) as e:negatives.append({'name':name,'rejected':type(e).__name__,'reason':str(e)})
 else:raise AssertionError('mutation accepted:'+name)
summary={'state':'passed','reader':{p:importlib.metadata.version(p) for p in ['EbookLib','lxml','six']},'artifactSha256':hashlib.sha256(data).hexdigest(),'fixtureSha256':hashlib.sha256((root/'tests/formats/consumers/epub-fixture.json').read_bytes()).hexdigest(),'fixtures':{'supported':result},'expected':expected,'negativeMutations':len(negatives),'mutations':negatives,'failed':0,'skipped':0}
(out/'epub-independent-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
