"""Independent generated EPUB reader. Authored semantic constants, never exporter output."""
import hashlib, importlib.util, importlib.metadata, io, json, pathlib, sys, zipfile
root=pathlib.Path.cwd();out=pathlib.Path(sys.argv[1])
spec=importlib.util.spec_from_file_location('epub_oracle',root/'tests/formats/inspect-epub-export.py');o=importlib.util.module_from_spec(spec);spec.loader.exec_module(o)
assert {p:importlib.metadata.version(p) for p in ['EbookLib','lxml','six']}=={'EbookLib':'0.20','lxml':'6.0.2','six':'1.17.0'}
f=json.loads((root/'tests/formats/consumers/docx-fixture.json').read_text());pixel=bytes(f['pixel'])
def run(text,marks=[]):return {'text':text,'marks':marks}
def paragraph(text,kind='p',lists=[]):return {'kind':kind,'runs':[run(text)],'lists':lists}
expected=[paragraph('EPUB 🙂 heading','h2'),{'kind':'p','runs':[run('Bold & <literal>',[['Bold',None]]),run(' linked',[['Link','https://example.test/safe']])],'lists':[]},
 {'kind':'p','runs':[run('Unicode e\u0301 العربية\tline\nlast\rreturn',[[m,None] for m in ['Italic','Underline','Strike']]),run(' code literal',[['Code',None]])],'lists':[]},
 paragraph('First item',lists=[['ol',3]]),paragraph('Nested bullet 🙂',lists=[['ol',3],['ul',1]]),paragraph('Second item',lists=[['ol',3]]),
 {'kind':'table','rows':[[[run('Cell A')],[run('Cell 🙂')]]],'alignments':['start','start']},
 {'kind':'image','alt':'Original pixel 🙂','caption':'local original','hash':hashlib.sha256(pixel).hexdigest(),'width':1,'height':1},
 paragraph('Second chapter','h1'),paragraph('Final reading order')]
expected[6],expected[7]=expected[7],expected[6]
raw=(out/'native-supported.epub').read_bytes();result=o.verify(raw,expected);assert result=={'chapters':2,'blocks':10,'images':1},result
with zipfile.ZipFile(io.BytesIO(raw)) as z:
 chapter=next(n for n in z.namelist() if n.startswith('EPUB/chapter-') and b'<strong>' in z.read(n));image=next(n for n in z.namelist() if n.endswith('.png'))
mutations=[('text',chapter,lambda b:b.replace(b'Cell A',b'Cell X')),('mark',chapter,lambda b:b.replace(b'<strong>',b'<em>').replace(b'</strong>',b'</em>')),('spine','EPUB/package.opf',lambda b:b.replace(b'<itemref idref="c0"/><itemref idref="c1"/>',b'<itemref idref="c1"/><itemref idref="c0"/>')),('toc','EPUB/nav.xhtml',lambda b:b.replace(b'chapter-0.xhtml',b'chapter-99.xhtml')),('image',image,lambda b:b[:-1]+bytes([b[-1]^1])),('active',chapter,lambda b:b.replace(b'</body>',b'<script>evil()</script></body>')),('metadata','EPUB/package.opf',lambda b:b.replace(b'>und<',b'>en<')),('remote',chapter,lambda b:b.replace(b'src="media/',b'src="https://evil.test/')),('alt',chapter,lambda b:b.replace(b'alt="Original',b'alt="Changed')),('caption',chapter,lambda b:b.replace(b'local original',b'wrong caption')),('link',chapter,lambda b:b.replace(b'https://example.test/safe',b'https://example.test/other'))]
for label,path,transform in mutations:
 changed=o.mutate(raw,path,transform);assert changed!=raw,label
 try:o.verify(changed,expected)
 except (AssertionError,KeyError,o.E.XMLSyntaxError):pass
 else:raise AssertionError('oracle accepted '+label)
summary={'passed':1+len(mutations),'failed':0,'skipped':0,'reader':{p:importlib.metadata.version(p) for p in ['EbookLib','lxml','six']},'semantics':result,'mutations':[m[0] for m in mutations]}
(out/'epub-oracle.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
