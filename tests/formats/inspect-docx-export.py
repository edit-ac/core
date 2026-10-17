"""Independent package/semantic oracle. No edit.ac or docx-rs reader code."""
import sys,zipfile,io,json,copy
from pathlib import Path
import xml.etree.ElementTree as E
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
P='{http://schemas.openxmlformats.org/package/2006/relationships}'
A='{http://schemas.openxmlformats.org/drawingml/2006/main}'
def read(path):
 with zipfile.ZipFile(path) as z:
  names=z.namelist();assert len(names)==len(set(names));assert not any(n.startswith('/') or '..' in n.split('/') or 'vbaProject' in n or 'embeddings/' in n for n in names)
  parts={n:z.read(n) for n in names}
  for n,b in parts.items():
   if n.endswith(('.xml','.rels')):E.fromstring(b)
 return parts
def inspect(parts,name):
 doc=E.fromstring(parts['word/document.xml']);rels=E.fromstring(parts['word/_rels/document.xml.rels']);ids=[r.attrib['Id'] for r in rels];assert len(ids)==len(set(ids))
 lookup={r.attrib['Id']:r for r in rels}
 for node in doc.iter():
  for key in [R+'id',R+'embed']:
   if key in node.attrib: assert node.attrib[key] in lookup
 for r in rels:
  target=r.attrib['Target'];assert '..' not in target.split('/')
  if r.attrib.get('TargetMode')=='External': assert r.attrib['Type'].endswith('/hyperlink') and target.startswith(('https://','http://','mailto:'))
  else: assert 'word/'+target in parts,target
 nums=E.fromstring(parts['word/numbering.xml']);abstract={n.attrib[W+'abstractNumId']:n for n in nums.findall(W+'abstractNum')};num={n.attrib[W+'numId']:abstract[n.find(W+'abstractNumId').attrib[W+'val']] for n in nums.findall(W+'num')}
 assert len(abstract)==len(nums.findall(W+'abstractNum')) and len(num)==len(nums.findall(W+'num'))
 for p in doc.iter(W+'p'):
  pr=p.find(W+'pPr/'+W+'numPr')
  if pr is not None:
   n=num[pr.find(W+'numId').attrib[W+'val']];level=pr.find(W+'ilvl').attrib[W+'val'];assert any(l.attrib[W+'ilvl']==level for l in n.findall(W+'lvl'))
 for local in ['docPr','cNvPr']:
  values=[n.attrib['id'] for n in doc.iter() if n.tag.endswith('}'+local)];assert len(values)==len(set(values)),(local,values)
 text=''.join(t.text or '' for t in doc.iter(W+'t'))
 if name=='supported':
  for t in ['Three','nested 🙂','Four','A','é🙂','link','tail']:assert t in text,t
  table=next(doc.iter(W+'tbl'));rows=table.findall(W+'tr');assert len(rows)==2 and all(len(r.findall(W+'tc'))==2 for r in rows)
  cells=[''.join(t.text or '' for t in c.iter(W+'t')) for r in rows for c in r.findall(W+'tc')];assert cells==['A','','é🙂','link'],cells
  assert rows[0].find('.//'+W+'b') is not None
  assert any(r.attrib['Target']=='https://example.test/' for r in rels)
  images=[r for r in rels if r.attrib['Type'].endswith('/image')];assert len(images)==1
  assert parts['word/'+images[0].attrib['Target']]==Path('fixtures/formats/docx/probe/pixel.png').read_bytes()
  assert any(l.find(W+'start').attrib[W+'val']=='3' for n in abstract.values() for l in n.findall(W+'lvl'))
 if name=='unicode':
  assert ' A & B 🦀 é العربية ' in text and 'tail' in text
  for t in ['b','i','u','strike','tab','br']:assert doc.find('.//'+W+t) is not None,t
  assert doc.find('.//'+W+'pStyle').attrib[W+'val']=='Heading2'
 if name=='lists':
  for start in ['3','10']:assert any(l.find(W+'start').attrib[W+'val']==start for n in abstract.values() for l in n.findall(W+'lvl'))
  assert any(l.find(W+'numFmt').attrib[W+'val']=='bullet' for n in abstract.values() for l in n.findall(W+'lvl'))
 if name=='localized':assert doc.find('.//'+W+'b') is not None
 if name=='literal-link':assert any(r.attrib['Target']=='https://example.test/?a=1&b=two#x' for r in rels)
 return text
out=Path(sys.argv[1]);names=['multiple-images','full-reimport','literal-link','supported','unicode','lists','reimport','plain','rich-wrapper','toc-wrapper','localized','empty-defaults','omitted-defaults']
texts={n:inspect(read(out/(n+'.docx')),n) for n in names}
# Reports must distinguish unsupported wrappers/fields from identical text.
reports={n:json.loads((out/(n+'-report.json')).read_text()) for n in ['plain','rich-wrapper','toc-wrapper']}
assert texts['plain']==texts['rich-wrapper']==texts['toc-wrapper'],texts
loss=lambda n:[d for d in reports[n]['diagnostics'] if d['lossy']]
assert not loss('plain') and loss('rich-wrapper') and len(loss('toc-wrapper'))>len(loss('rich-wrapper'))
# Sensitivity: changed cell, missing image, dangling relationship, reset list.
p=read(out/'supported.docx');mutations=[]
a=dict(p);a['word/document.xml']=a['word/document.xml'].replace(b'>A<',b'>WRONG<');mutations.append(a)
a=dict(p);a['word/numbering.xml']=a['word/numbering.xml'].replace(b'w:val="3"',b'w:val="1"');mutations.append(a)
a=dict(p);a['word/_rels/document.xml.rels']=a['word/_rels/document.xml.rels'].replace(b'https://example.test/',b'https://wrong.test/');mutations.append(a)
a={k:v for k,v in p.items() if not k.startswith('word/media/')};mutations.append(a)
for i,a in enumerate(mutations):
 try:inspect(a,'supported')
 except (AssertionError,KeyError):pass
 else:raise AssertionError(f'insensitive oracle {i}')
(out/'independent-summary.json').write_text(json.dumps({'packages':len(names),'sensitivityMutationsRejected':len(mutations),'texts':texts},ensure_ascii=False,indent=2)+'\n')
print('13 independent package/semantic inspections; 4 bad-output mutations rejected')
