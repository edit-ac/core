"""Native authored chapter/text variants; shared original fixtures stay unchanged."""
import hashlib,io,json,re,zipfile

def create(directory):
 source=directory/'supported.epub';entries={}
 with zipfile.ZipFile(source) as z:
  for n in z.namelist():
   if n=='EPUB/images/pixel.png':continue
   data=z.read(n)
   if n=='EPUB/package.opf':data=re.sub(rb'<item id="pixel"[^>]*/>',b'',data)
   entries[n]=data
 def package(changes):
  out=io.BytesIO()
  with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_STORED) as z:
   for n,data in entries.items():z.writestr(zipfile.ZipInfo(n,(2026,1,1,0,0,0)),changes.get(n,data))
  return out.getvalue()
 first=entries['EPUB/text/first.xhtml'];nav=entries['EPUB/nav.xhtml'];opf=entries['EPUB/package.opf']
 fixtures={'text':package({}),'active':package({'EPUB/text/first.xhtml':first.replace(b'</body>',b'<script>forbidden script</script><form><input value="private"/></form></body>')}),'nav-remote':package({'EPUB/nav.xhtml':nav.replace(b'text/second.xhtml#second',b'https://example.invalid/remote')})}
 records=json.loads((directory/'manifest.json').read_text())
 for name,data in fixtures.items():
  (directory/(name+'.epub')).write_bytes(data);records[name]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
 (directory/'manifest.json').write_text(json.dumps(records,indent=2)+'\n')
