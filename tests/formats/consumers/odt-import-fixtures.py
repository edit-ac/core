"""Deterministic hand-authored ODF1.3 sources, never converter-generated."""
import hashlib,io,json,pathlib,re,sys,zipfile
out=pathlib.Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
source=pathlib.Path('fixtures/formats/odt/supported.xml').read_text()
pixel=pathlib.Path('fixtures/formats/docx/probe/pixel.png').read_bytes()
M='urn:oasis:names:tc:opendocument:xmlns:manifest:1.0';mime='application/vnd.oasis.opendocument.text'
manifest=f'<manifest:manifest xmlns:manifest="{M}" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="{mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="Pictures/pixel.png" manifest:media-type="image/png"/></manifest:manifest>'
plain=re.sub(r'<text:p><draw:frame.*?</text:p>','',source,flags=re.S)
def package(content,m=manifest,extras=()):
 b=io.BytesIO()
 with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_STORED) as z:
  for name,data in [('mimetype',mime),('META-INF/manifest.xml',m),('content.xml',content),('Pictures/pixel.png',pixel),*extras]:z.writestr(zipfile.ZipInfo(name,(2026,1,1,0,0,0)),data)
 return b.getvalue()
loss=source.replace('</office:text>','<text:p><text:date>opaque retained</text:date></text:p></office:text>')
fixtures={'supported':package(plain),'media':package(source),'media-loss':package(loss),'loss':package(re.sub(r'<text:p><draw:frame.*?</text:p>','',loss,flags=re.S)),'remote':package(source.replace('Pictures/pixel.png','https://example.invalid/private.png')),'encrypted':package('not XML ciphertext',manifest.replace('manifest:media-type="text/xml"/>','manifest:media-type="text/xml"><manifest:encryption-data/></manifest:file-entry>')),'corrupt':b'PK\x03\x04not-a-zip','hostile':package(plain,extras=[('../escape.xml','forbidden')]),'nodes':package(plain.replace('</office:text>','<text:p>overflow</text:p>'*130+'</office:text>'))}
records={}
for name,data in fixtures.items():
 (out/(name+'.odt')).write_bytes(data);records[name]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
(out/'manifest.json').write_text(json.dumps(records,indent=2)+'\n');print(json.dumps({'fixtures':len(fixtures)}))
