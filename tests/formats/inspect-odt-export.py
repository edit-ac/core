"""Independent output oracle: OASIS RNG/lxml + odfpy; never calls edit.ac import.
Validation-only dependencies are preinstalled explicitly; no network access here.
"""
import copy, hashlib, importlib.metadata, io, json, pathlib, struct, sys, zipfile
from lxml import etree
from odf.opendocument import load
from odf import text, table, draw, teletype
assert importlib.metadata.version('odfpy') == '1.4.1'
assert importlib.metadata.version('lxml') == '6.0.2'
root = pathlib.Path(__file__).resolve().parents[2]
output = pathlib.Path(sys.argv[1])
schemas = root / 'fixtures/formats/odt/export/schema'
parser = etree.XMLParser(resolve_entities=False, no_network=True)
content_schema = etree.RelaxNG(etree.parse(str(schemas/'OpenDocument-v1.3-schema.rng'), parser))
manifest_schema = etree.RelaxNG(etree.parse(str(schemas/'OpenDocument-v1.3-manifest-schema.rng'), parser))
N = {'office':'urn:oasis:names:tc:opendocument:xmlns:office:1.0','text':'urn:oasis:names:tc:opendocument:xmlns:text:1.0','style':'urn:oasis:names:tc:opendocument:xmlns:style:1.0','fo':'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0','table':'urn:oasis:names:tc:opendocument:xmlns:table:1.0','draw':'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0','svg':'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0','xlink':'http://www.w3.org/1999/xlink','manifest':'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0'}
MIME=b'application/vnd.oasis.opendocument.text'
EXPECTED=' A & <B> "quoted" 🦀 é العربية  \tline\nlast\rreturn '
pixel=(root/'fixtures/formats/docx/probe/pixel.png').read_bytes()
media='Pictures/'+hashlib.sha256(pixel).hexdigest()+'.png'
def q(ns,name): return '{'+N[ns]+'}'+name
def inspect(data):
    assert data[:4] == b'PK\x03\x04'
    method=struct.unpack_from('<H',data,8)[0]; n,e=struct.unpack_from('<HH',data,26)
    assert method==0 and e==0 and data[30:30+n]==b'mimetype'
    z=zipfile.ZipFile(io.BytesIO(data)); names=z.namelist()
    assert len(names)==len(set(names)) and names[0]=='mimetype'
    assert set(names)=={'mimetype','content.xml','META-INF/manifest.xml',media}
    assert z.read('mimetype')==MIME and z.read(media)==pixel
    xml=etree.fromstring(z.read('content.xml'),parser); manifest=etree.fromstring(z.read('META-INF/manifest.xml'),parser)
    assert content_schema.validate(xml), str(content_schema.error_log)
    assert manifest_schema.validate(manifest), str(manifest_schema.error_log)
    entries={e.get(q('manifest','full-path')):e.get(q('manifest','media-type')) for e in manifest}
    assert entries=={'/':MIME.decode(),'content.xml':'text/xml',media:'image/png'}
    assert not xml.xpath('//office:scripts|//office:forms',namespaces=N)
    refs=xml.xpath('//@xlink:href',namespaces=N)
    assert sorted(refs)==sorted([media,'https://example.test/a?x=1&y=2'])
    assert not xml.xpath('//office:meta',namespaces=N)
    # Independent ODF reader loads the actual package, text, nesting and tables.
    doc=load(io.BytesIO(data)); hs=doc.getElementsByType(text.H)
    assert len(hs)==1 and hs[0].getAttribute('outlinelevel')=='2'
    assert teletype.extractText(hs[0])==EXPECTED,repr(teletype.extractText(hs[0]))
    paragraphs=[teletype.extractText(e) for e in doc.getElementsByType(text.P)]
    for s in ['safe link','number-first','nested-bullet','number-second','adjacent-bullet','cell A','cell B 🙂','0']:
        assert s in paragraphs,(s,paragraphs)
    ts=doc.getElementsByType(table.Table); assert len(ts)==1
    rows=ts[0].getElementsByType(table.TableRow);assert len(rows)==2
    cells=[[teletype.extractText(c) for c in r.getElementsByType(table.TableCell)] for r in rows]
    assert cells==[['cell A','cell B 🙂'],['','0']],cells
    lists=doc.getElementsByType(text.List); assert len(lists)==3
    assert len(lists[0].getElementsByType(text.ListItem))==3
    assert len(lists[1].getElementsByType(text.ListItem))==1
    assert teletype.extractText(lists[1])=='nested-bullet'
    styles=xml.xpath('//text:list-style',namespaces=N)
    assert len(styles)==3
    ordered=[s for s in styles if s.xpath('text:list-level-style-number',namespaces=N)]
    assert len(ordered)==1 and all(e.get(q('text','start-value'))=='7' for e in ordered[0])
    style=xml.xpath('//style:style[@style:name="T31"]/style:text-properties',namespaces=N)[0]
    assert style.get(q('fo','font-weight'))=='bold' and style.get(q('fo','font-style'))=='italic'
    assert style.get(q('style','text-underline-style'))=='solid' and style.get(q('style','text-line-through-style'))=='solid'
    assert style.get(q('fo','font-family'))=='monospace'
    assert hs[0].getElementsByType(text.Span)[0].getAttribute('stylename')=='T15'
    assert any(teletype.extractText(s)=='code literal' and s.getAttribute('stylename')=='T16' for s in doc.getElementsByType(text.Span))
    rich=xml.xpath('//table:table-row[1]/table:table-cell[1]//text:span',namespaces=N)[0]
    assert rich.get(q('text','style-name'))=='T1'
    assert xml.xpath('//table:table-cell[2]/text:p/@text:style-name',namespaces=N)==['Aright','Aright']
    images=doc.getElementsByType(draw.Image);assert len(images)==1 and images[0].getAttribute('href')==media
    assert xml.xpath('string(//svg:title)',namespaces=N)=='caption & title'
    assert xml.xpath('string(//svg:desc)',namespaces=N)=='alt < 🙂'
    return {'paragraphs':paragraphs,'heading':EXPECTED,'rows':cells,'images':1,'lists':3,'reader':'odfpy1.4.1','schema':'OASIS ODF1.3 RNG/lxml6.0.2'}
data=(output/'export-supported.odt').read_bytes(); projection=inspect(data)
report=json.loads((output/'export-supported-report.json').read_text())
assert not any(d['lossy'] for d in report['diagnostics'])
assert {d['code'] for d in report['diagnostics']}=={'PACKAGE_REGENERATED','STYLE_DEFAULTS','METADATA_DEFAULTS'}
lossy=json.loads((output/'export-lossy-report.json').read_text());assert any(d['code']=='UNSUPPORTED_BLOCK_STYLE' and d['lossy'] for d in lossy['diagnostics'])
original=zipfile.ZipFile(io.BytesIO(data)); parts={n:original.read(n) for n in original.namelist()}
mutations=[('text','content.xml',lambda b:b.replace('quoted'.encode(),b'broken')),('mark','content.xml',lambda b:b.replace(b'text:style-name="T15"',b'text:style-name="T0"')),('list-start','content.xml',lambda b:b.replace(b'text:start-value="7"',b'text:start-value="1"')),('table-cell','content.xml',lambda b:b.replace(b'cell<text:s/>A',b'bad<text:s/>A')),('media',media,lambda b:b[:-1]+bytes([b[-1]^1])),('manifest','META-INF/manifest.xml',lambda b:b.replace(b'image/png',b'text/plain'))]
neg=[]
for name,part,mutate in mutations:
    ps=copy.copy(parts); ps[part]=mutate(ps[part]);assert ps[part]!=parts[part],name
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_STORED) as z:
        for n,b in ps.items():z.writestr(n,b)
    (output/('negative-'+name+'.odt')).write_bytes(stream.getvalue())
    try: inspect(stream.getvalue())
    except (AssertionError,ValueError):neg.append(name)
    else:raise AssertionError('oracle accepted '+name)
result={'state':'passed','projection':projection,'negativeMutations':neg,'dependencies':{n:importlib.metadata.version(n) for n in ['odfpy','lxml','defusedxml']},'artifactSha256':hashlib.sha256(data).hexdigest()}
(output/'independent-reader.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
print(json.dumps({'state':'passed','negativeMutations':len(neg),'images':1,'rows':2}))
