"""Deterministic original EPUB3.3 packages, independent of converter output."""
import hashlib,io,json,pathlib,re,sys,zipfile
out=pathlib.Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
root=pathlib.Path('fixtures/formats/epub')
container=(root/'container.xml').read_text();opf=(root/'package.opf').read_text()
nav=(root/'nav.xhtml').read_text();first=(root/'first.xhtml').read_text();second=(root/'second.xhtml').read_text()
pixel=pathlib.Path('fixtures/formats/docx/probe/pixel.png').read_bytes()
def package(chapter=first,package=opf,navigation=nav,extras=()):
 b=io.BytesIO()
 with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_STORED) as z:
  for name,data in [('mimetype','application/epub+zip'),('META-INF/container.xml',container),('EPUB/package.opf',package),('EPUB/nav.xhtml',navigation),('EPUB/text/first.xhtml',chapter),('EPUB/text/second.xhtml',second),('EPUB/images/pixel.png',pixel),*extras]:
   z.writestr(zipfile.ZipInfo(name,(2026,1,1,0,0,0)),data)
 return b.getvalue()
plain=re.sub(r'<p><img .*?</p>','',first)
active='<script>forbidden script</script><form><input value="private"/></form><p><img src="https://example.invalid/private.png" alt="remote"/></p>'
loss=first.replace('</body>',active+'</body>')
fixtures={'supported':package(plain),'media':package(),'media-loss':package(loss),
 'remote':package(plain.replace('</body>','<p><img src="https://example.invalid/private.png" alt="remote"/></p></body>')),
 'encrypted':package(extras=[('META-INF/encryption.xml','<encryption/>')]),
 'fixed':package(package=opf.replace('<metadata>','<metadata><meta property="rendition:layout">pre-paginated</meta>')),
 'corrupt':b'PK\x03\x04not-a-zip','hostile':package(extras=[('../escape.xml','forbidden')]),
 'nodes':package(first.replace('</body>','<p>overflow</p>'*130+'</body>')),
 'navigation':package(navigation=nav.replace('text/second.xhtml#second','https://example.invalid/remote'))}
records={}
for name,data in fixtures.items():
 (out/(name+'.epub')).write_bytes(data);records[name]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
(out/'manifest.json').write_text(json.dumps(records,indent=2)+'\n');print(json.dumps({'fixtures':len(fixtures)}))
