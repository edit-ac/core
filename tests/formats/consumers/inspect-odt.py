"""Independent OASIS RNG and odfpy reader of generated packed-browser ODT only."""
import copy, hashlib, importlib.metadata, io, json, pathlib, struct, sys, zipfile
# Avoid the neighboring validation fixture inspect.py shadowing stdlib inspect.
sys.path=[p for p in sys.path if pathlib.Path(p or '.').resolve()!=pathlib.Path(__file__).resolve().parent]
from lxml import etree as E
from odf.opendocument import load
from odf import text, table, draw, teletype
out=pathlib.Path(sys.argv[1]); root=pathlib.Path.cwd()
fixture=json.loads((root/'tests/formats/consumers/odt-fixture.json').read_text())
assert importlib.metadata.version('odfpy')=='1.4.1'
assert importlib.metadata.version('lxml')=='6.0.2'
parser=E.XMLParser(resolve_entities=False,no_network=True)
base=root/'fixtures/formats/odt/export/schema'
schema=E.RelaxNG(E.parse(str(base/'OpenDocument-v1.3-schema.rng'),parser))
manifest_schema=E.RelaxNG(E.parse(str(base/'OpenDocument-v1.3-manifest-schema.rng'),parser))
N={'office':'urn:oasis:names:tc:opendocument:xmlns:office:1.0','text':'urn:oasis:names:tc:opendocument:xmlns:text:1.0','style':'urn:oasis:names:tc:opendocument:xmlns:style:1.0','fo':'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0','table':'urn:oasis:names:tc:opendocument:xmlns:table:1.0','draw':'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0','svg':'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0','xlink':'http://www.w3.org/1999/xlink','manifest':'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0'}
def q(ns,name):return '{'+N[ns]+'}'+name
pixel=bytes(fixture['pixel']);media='Pictures/'+hashlib.sha256(pixel).hexdigest()+'.png'
MIME=b'application/vnd.oasis.opendocument.text'
def pack(parts):
 stream=io.BytesIO()
 with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_STORED) as z:
  for n,b in parts.items():z.writestr(n,b)
 return stream.getvalue()
def inspect(raw):
 assert raw[:4]==b'PK\x03\x04'
 assert struct.unpack_from('<H',raw,8)[0]==0
 n,e=struct.unpack_from('<HH',raw,26);assert e==0 and raw[30:30+n]==b'mimetype'
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  names=z.namelist();assert len(names)==len(set(names)) and names[0]=='mimetype'
  assert set(names)=={'mimetype','content.xml','META-INF/manifest.xml',media}
  assert z.read('mimetype')==MIME and z.read(media)==pixel
  xml=E.fromstring(z.read('content.xml'),parser);manifest=E.fromstring(z.read('META-INF/manifest.xml'),parser)
 assert schema.validate(xml),str(schema.error_log)
 assert manifest_schema.validate(manifest),str(manifest_schema.error_log)
 entries={x.get(q('manifest','full-path')):x.get(q('manifest','media-type')) for x in manifest}
 assert entries=={'/':MIME.decode(),'content.xml':'text/xml',media:'image/png'}
 assert not xml.xpath('//office:scripts|//office:forms|//office:meta',namespaces=N)
 assert sorted(xml.xpath('//@xlink:href',namespaces=N))==sorted([media,'https://example.test/safe'])
 doc=load(io.BytesIO(raw));hs=doc.getElementsByType(text.H)
 assert len(hs)==1 and hs[0].getAttribute('outlinelevel')=='2'
 assert teletype.extractText(hs[0])=='ODT 🙂 heading'
 paragraphs=[teletype.extractText(x) for x in doc.getElementsByType(text.P)]
 assert 'LATER' not in '\n'.join(paragraphs)
 for s in ['Bold & <literal> linked','Unicode é العربية\tline\nlast\rreturn code literal','First item','Nested bullet 🙂','Second item','Cell A','Cell 🙂']:assert s in paragraphs,(s,paragraphs)
 def span_props(label):
  matches=[x for x in doc.getElementsByType(text.Span) if teletype.extractText(x)==label]
  assert len(matches)==1,(label,[teletype.extractText(x) for x in doc.getElementsByType(text.Span)])
  return xml.xpath('//style:style[@style:name=$name]/style:text-properties',namespaces=N,name=matches[0].getAttribute('stylename'))[0]
 bold=span_props('Bold & <literal>')
 assert bold.get(q('fo','font-weight'))=='bold'
 props=span_props('Unicode é العربية\tline\nlast\rreturn')
 assert props.get(q('fo','font-style'))=='italic' and props.get(q('style','text-underline-style'))=='solid'
 assert props.get(q('style','text-line-through-style'))=='solid'
 assert span_props(' code literal').get(q('fo','font-family'))=='monospace'
 assert any(x.get(q('text','start-value'))=='3' for x in xml.xpath('//text:list-level-style-number',namespaces=N))
 assert len(doc.getElementsByType(text.List))==2
 assert [teletype.extractText(x) for x in doc.getElementsByType(table.TableCell)]==['Cell A','Cell 🙂']
 assert len(doc.getElementsByType(draw.Image))==1
 assert xml.xpath('string(//svg:title)',namespaces=N)==fixture['descriptor']['metadata']['caption']
 assert xml.xpath('string(//svg:desc)',namespaces=N)==fixture['descriptor']['metadata']['alt']
 return {'heading':teletype.extractText(hs[0]),'paragraphs':paragraphs,'imageSha256':hashlib.sha256(pixel).hexdigest(),'reader':'odfpy1.4.1','schema':'OASIS ODF1.3 RNG/lxml6.0.2'}
raw=(out/'browser-supported.odt').read_bytes();projection=inspect(raw)
with zipfile.ZipFile(io.BytesIO(raw)) as z:parts={n:z.read(n) for n in z.namelist()}
mutations=[]
for name,part,mutate in [
 ('text','content.xml',lambda b:b.replace(b'ODT',b'BROKEN')),
 ('mark','content.xml',lambda b:b.replace(b'fo:font-weight="bold"',b'fo:font-weight="normal"')),
 ('numbering','content.xml',lambda b:b.replace(b'text:start-value="3"',b'text:start-value="1"')),
 ('table','content.xml',lambda b:b.replace(b'Cell<text:s/>A',b'Cell<text:s/>X')),
 ('link','content.xml',lambda b:b.replace(b'https://example.test/safe',b'https://wrong.test/')),
 ('accessibility','content.xml',lambda b:b.replace(b'Original<text:s/>pixel',b'Wrong<text:s/>pixel') if b'Original<text:s/>pixel' in b else b.replace(b'Original pixel',b'Wrong pixel')),
 ('manifest','META-INF/manifest.xml',lambda b:b.replace(b'image/png',b'text/plain')),
 ('original-image',media,lambda b:b[:-1]+bytes([b[-1]^1]))]:
 changed=copy.copy(parts);changed[part]=mutate(parts[part]);assert changed[part]!=parts[part],name
 artifact=pack(changed);(out/('odt-negative-'+name+'.odt')).write_bytes(artifact)
 try:inspect(artifact)
 except (AssertionError,ValueError,KeyError):mutations.append(name)
 else:raise AssertionError('oracle missed '+name)
receipt={'artifactSha256':hashlib.sha256(raw).hexdigest(),'fixtureSha256':hashlib.sha256((root/'tests/formats/consumers/odt-fixture.json').read_bytes()).hexdigest(),'projection':projection,'negativeMutations':mutations,'passed':9,'failed':0,'skipped':0,'dependencies':{n:importlib.metadata.version(n) for n in ['odfpy','lxml','defusedxml']}}
(out/'odt-oracle.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n');print(json.dumps(receipt,ensure_ascii=False))
