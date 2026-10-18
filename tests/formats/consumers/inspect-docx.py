"""Independent standard-library reader of generated browser artifacts only."""
import io,json,sys,zipfile,hashlib,copy
from pathlib import Path
from xml.etree import ElementTree as E
out=Path(sys.argv[1]);fixture=json.loads(Path('tests/formats/consumers/docx-fixture.json').read_text())
raw=(out/'browser-supported.docx').read_bytes()
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R='{http://schemas.openxmlformats.org/package/2006/relationships}'
A='{http://schemas.openxmlformats.org/drawingml/2006/main}'
with zipfile.ZipFile(io.BytesIO(raw)) as z:
 assert len(z.namelist())==len(set(z.namelist()))
 parts={n:z.read(n) for n in z.namelist()}
def inspect(parts):
 doc=E.fromstring(parts['word/document.xml']);text=''.join(doc.itertext())
 assert 'DOCX 🙂 heading' in text and 'LATER' not in text
 heading=next(p for p in doc.iter(W+'p') if 'DOCX 🙂 heading' in ''.join(p.itertext()))
 assert heading.find('./'+W+'pPr/'+W+'pStyle').get(W+'val')=='Heading2'
 bold=next(r for r in doc.iter(W+'r') if 'Bold & <literal>' in ''.join(r.itertext()))
 assert bold.find('./'+W+'rPr/'+W+'b') is not None
 assert [''.join(c.itertext()) for c in doc.findall('.//'+W+'tbl/'+W+'tr/'+W+'tc')]==['Cell A','Cell 🙂']
 nums=E.fromstring(parts['word/numbering.xml'])
 assert any(n.get(W+'val')=='3' for n in nums.iter(W+'start'))
 item=next(p for p in doc.iter(W+'p') if 'First item' in ''.join(p.itertext()))
 assert item.find('./'+W+'pPr/'+W+'numPr') is not None
 rels=E.fromstring(parts['word/_rels/document.xml.rels'])
 assert any(r.get('Target')=='https://example.test/safe' and r.get('TargetMode')=='External' for r in rels)
 assert len(list(doc.iter(W+'hyperlink')))==1
 images=[r for r in rels if r.get('Type','').endswith('/image')]
 assert len(images)==1
 target=images[0].get('Target');image=parts['word/'+target] if not target.startswith('/') else parts[target[1:]]
 assert image==bytes(fixture['pixel'])
 assert len(list(doc.iter(A+'blip')))==1
 assert not any(n.endswith(('.bin','.vba')) for n in parts)
 return {'text':text,'imageSha256':hashlib.sha256(image).hexdigest(),'parts':len(parts)}
result=inspect(parts);mutations=[]
for label,part,before,after in [
 ('text','word/document.xml',b'DOCX ',b'BROKEN '),
 ('table','word/document.xml',b'Cell A',b'Cell X'),
 ('link','word/_rels/document.xml.rels',b'https://example.test/safe',b'https://wrong.test/'),
 ('numbering','word/numbering.xml',b'w:val="3"',b'w:val="1"'),
]:
 changed=copy.copy(parts);assert before in changed[part],label
 changed[part]=changed[part].replace(before,after)
 try:inspect(changed)
 except (AssertionError,KeyError):mutations.append(label)
 else:raise AssertionError('oracle missed '+label)
changed=copy.copy(parts)
doc=E.fromstring(changed['word/document.xml'])
for props in doc.iter(W+'rPr'):
 for bold in list(props.findall(W+'b')):props.remove(bold)
changed['word/document.xml']=E.tostring(doc,encoding='utf-8')
try:inspect(changed)
except (AssertionError,KeyError):mutations.append('bold')
else:raise AssertionError('oracle missed bold')
changed=copy.copy(parts)
for key in changed:
 if key.endswith('.png'):changed[key]=b'corrupt'
try:inspect(changed)
except (AssertionError,KeyError):mutations.append('original-image')
else:raise AssertionError('oracle missed original-image')
receipt={'artifactSha256':hashlib.sha256(raw).hexdigest(),'fixtureSha256':hashlib.sha256(Path('tests/formats/consumers/docx-fixture.json').read_bytes()).hexdigest(),'supported':result,'negativeMutations':mutations,'passed':7,'failed':0,'skipped':0}
(out/'docx-oracle.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n');print(json.dumps(receipt,ensure_ascii=False))
