"""Independent ZIP/XML + macOS textutil inspection of generated DOCX only."""
import copy, hashlib, io, json, pathlib, subprocess, sys, zipfile
from xml.etree import ElementTree as E

out=pathlib.Path(sys.argv[1]);root=pathlib.Path.cwd()
fixture=root/'tests/formats/consumers/docx-fixture.json'
pixel=bytes(json.loads(fixture.read_text())['pixel'])
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R='{http://schemas.openxmlformats.org/package/2006/relationships}'
A='{http://schemas.openxmlformats.org/drawingml/2006/main}'

def text(element):
 return ''.join(e.text or '' if e.tag==W+'t' else '\t' if e.tag==W+'tab' else '\n' if e.tag==W+'br' else '\r' if e.tag==W+'cr' else '' for e in element.iter())

def inspect(parts):
 doc=E.fromstring(parts['word/document.xml']);ps=list(doc.iter(W+'p'))
 assert not any(n.endswith(('.bin','.vba')) for n in parts)
 assert not list(doc.iter(W+'altChunk')) and not list(doc.iter(W+'sdt'))
 heading=next(p for p in ps if text(p)=='DOCX 🙂 heading')
 assert heading.find('./'+W+'pPr/'+W+'pStyle').get(W+'val')=='Heading2'
 bold=next(r for r in doc.iter(W+'r') if text(r)=='Bold & <literal>')
 assert bold.find('./'+W+'rPr/'+W+'b') is not None
 unicode=next(p for p in ps if text(p).startswith('Unicode'))
 assert text(unicode)=='Unicode e\u0301 العربية\tline\nlast\rreturn code literal'
 run=next(unicode.iter(W+'r'))
 for mark in ('i','u','strike'):assert run.find('./'+W+'rPr/'+W+mark) is not None
 assert [text(c) for c in doc.findall('.//'+W+'tbl/'+W+'tr/'+W+'tc')]==['Cell A','Cell 🙂']
 items=[next(p for p in ps if text(p)==t) for t in ('First item','Nested bullet 🙂','Second item')]
 ids=[p.find('./'+W+'pPr/'+W+'numPr/'+W+'numId').get(W+'val') for p in items]
 levels=[p.find('./'+W+'pPr/'+W+'numPr/'+W+'ilvl').get(W+'val') for p in items]
 assert ids[0]==ids[2] and levels==['0','1','0']
 nums=E.fromstring(parts['word/numbering.xml'])
 assert any(n.get(W+'val')=='3' for n in nums.iter(W+'start'))
 assert any(n.get(W+'val')=='bullet' for n in nums.iter(W+'numFmt'))
 rels=E.fromstring(parts['word/_rels/document.xml.rels'])
 assert [r.get('Target') for r in rels if r.get('TargetMode')=='External']==['https://example.test/safe']
 assert len(list(doc.iter(W+'hyperlink')))==1
 images=[r for r in rels if r.get('Type','').endswith('/image')];assert len(images)==1
 target=images[0].get('Target');image=parts['word/'+target] if not target.startswith('/') else parts[target[1:]]
 assert image==pixel and len(list(doc.iter(A+'blip')))==1
 alltext='\n'.join(map(text,ps));assert 'LATER_PRIVATE_EDIT' not in alltext
 assert alltext.index('DOCX 🙂 heading')<alltext.index('Bold & <literal>')<alltext.index('Unicode')<alltext.index('First item')<alltext.index('Nested bullet')<alltext.index('Second item')<alltext.index('Cell A')
 return {'text':alltext,'imageSha256':hashlib.sha256(image).hexdigest(),'parts':len(parts),'listLevels':levels}

raw=(out/'native-supported.docx').read_bytes()
with zipfile.ZipFile(io.BytesIO(raw)) as z:
 assert len(z.namelist())==len(set(z.namelist()))
 parts={n:z.read(n) for n in z.namelist()}
result=inspect(parts);mutations=[]
def negative(label,changed):
 try:inspect(changed)
 except (AssertionError,KeyError,StopIteration,AttributeError):mutations.append(label)
 else:raise AssertionError('oracle missed '+label)
for label,part,before,after in [
 ('text','word/document.xml',b'DOCX ',b'BROKEN '),
 ('table','word/document.xml',b'Cell A',b'Cell X'),
 ('link','word/_rels/document.xml.rels',b'https://example.test/safe',b'https://wrong.test/'),
 ('numbering','word/numbering.xml',b'w:val="3"',b'w:val="1"'),
 ('unicode','word/document.xml','e\u0301'.encode(),b'e'),
 ('nested-list','word/document.xml',b'w:ilvl w:val="1"',b'w:ilvl w:val="0"'),
]:
 changed=copy.copy(parts);assert before in changed[part],label
 changed[part]=changed[part].replace(before,after);negative(label,changed)
for tag in ('tab','br'):
 changed=copy.copy(parts);doc=E.fromstring(changed['word/document.xml']);removed=0
 for parent in doc.iter():
  for node in list(parent.findall(W+tag)):parent.remove(node);removed+=1
 assert removed>0,tag
 changed['word/document.xml']=E.tostring(doc,encoding='utf-8');negative(tag,changed)
for mark in ('b','i','u','strike'):
 changed=copy.copy(parts);doc=E.fromstring(changed['word/document.xml'])
 for props in doc.iter(W+'rPr'):
  for node in list(props.findall(W+mark)):props.remove(node)
 changed['word/document.xml']=E.tostring(doc,encoding='utf-8');negative(mark,changed)
changed=copy.copy(parts)
for key in changed:
 if key.endswith('.png'):changed[key]=b'corrupt'
negative('original-image',changed)
reader=subprocess.run(['/usr/bin/textutil','-convert','txt','-stdout',str(out/'native-supported.docx')],capture_output=True)
(out/'docx-textutil.stderr').write_bytes(reader.stderr)
assert reader.returncode==0,reader.stderr
logical=reader.stdout.decode();(out/'docx-textutil.txt').write_text(logical)
for token in ('DOCX 🙂 heading','Bold & <literal>','Unicode e\u0301 العربية','First item','Nested bullet 🙂','Second item','Cell A','Cell 🙂'):
 assert token in logical,token
assert 'LATER_PRIVATE_EDIT' not in logical
receipt={'artifactSha256':hashlib.sha256(raw).hexdigest(),'fixtureSha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'supported':result,'negativeMutations':mutations,'reader':{'program':'/usr/bin/textutil','exit':reader.returncode,'sha256':hashlib.sha256(pathlib.Path('/usr/bin/textutil').read_bytes()).hexdigest()},'passed':len(mutations)+2,'failed':0,'skipped':0}
(out/'docx-oracle.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n');print(json.dumps(receipt,ensure_ascii=False))
