"""Independent stdlib inspection of original ODF package; runtime has no Python dependency."""
import sys,json,zipfile,xml.etree.ElementTree as E,hashlib,io
from pathlib import Path
out=Path(sys.argv[1]);ns={p:'urn:oasis:names:tc:opendocument:xmlns:'+s+':1.0' for p,s in [('o','office'),('t','text'),('m','manifest'),('tb','table'),('d','drawing')]};ns['x']='http://www.w3.org/1999/xlink'
def inspect(data):
 with zipfile.ZipFile(io.BytesIO(data)) as z:
  first=z.infolist()[0];assert first.filename=='mimetype' and first.compress_type==0 and not first.extra
  assert z.read('mimetype')==b'application/vnd.oasis.opendocument.text'
  m=E.fromstring(z.read('META-INF/manifest.xml'));entries={e.attrib['{'+ns['m']+'}full-path']:e.attrib['{'+ns['m']+'}media-type'] for e in m};assert entries['content.xml']=='text/xml'
  r=E.fromstring(z.read('content.xml'));assert r.attrib['{'+ns['o']+'}version']=='1.3'
  assert r.find('.//t:h',ns).text=='Heading 🙂';assert r.find('.//t:a',ns).attrib['{'+ns['x']+'}href']=='https://example.test/?a=1&b=2'
  assert len(r.findall('.//tb:table-row',ns))==2
  assert [len(tr.findall('tb:table-cell',ns)) for tr in r.findall('.//tb:table-row',ns)]==[2,2]
  image=r.find('.//d:image',ns).attrib['{'+ns['x']+'}href'];png=z.read(image);assert entries[image]=='image/png' and png.startswith(b'\x89PNG\r\n\x1a\n');assert int.from_bytes(png[16:20],'big')==1
  p=r.findall('.//t:p',ns)[0];assert ''.join(p.itertext()).startswith('ABC🙂DE & Ω')
  return {'images':1,'rows':2,'pngSha256':hashlib.sha256(png).hexdigest()}
data=(out/'supported.odt').read_bytes();r=inspect(data)
with zipfile.ZipFile(io.BytesIO(data)) as z:parts={n:z.read(n) for n in z.namelist()}
for name,old,new in [('mimetype',b'application/vnd.oasis.opendocument.text',b'application/zip'),('content.xml','Heading 🙂'.encode(),b'Missing heading'),('content.xml',b'<table:table-cell><text:p>=1+1</text:p></table:table-cell>',b'')]:
 mutated=io.BytesIO()
 with zipfile.ZipFile(mutated,'w') as z:
  for n,b in parts.items():z.writestr(n,b.replace(old,new) if n==name else b)
 try:inspect(mutated.getvalue())
 except (AssertionError,KeyError):pass
 else:raise AssertionError('mutation passed: '+name)
projection=(out/'supported-projection.txt').read_text();assert 'ABC🙂DE & Ω  \tx\nend' in projection and 'Three\nnested 🙂\nFour' in projection and '=1+1' in projection and 'alt 🙂' in projection
r.update(state='passed',negativeMutations=3,packageSha256=hashlib.sha256(data).hexdigest());(out/'odt-independent.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
