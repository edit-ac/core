"""Original deterministic OOXML fixtures; stdlib ZIP/XML oracle, no converter."""
import hashlib, io, json, pathlib, re, sys, zipfile
from xml.etree import ElementTree as ET
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PR = 'http://schemas.openxmlformats.org/package/2006/relationships'
ct = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
root = f'<Relationships xmlns="{PR}"><Relationship Id="doc" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>'
rels = f'<Relationships xmlns="{PR}"><Relationship Id="numbering" Type="{R}/numbering" Target="numbering.xml"/><Relationship Id="web" Type="{R}/hyperlink" Target="https://example.test/" TargetMode="External"/></Relationships>'
numbering = pathlib.Path('fixtures/formats/docx/structure/numbering.xml').read_text()
source = pathlib.Path('fixtures/formats/docx/structure/supported.xml').read_text()
# Remove the one image paragraph, not its surrounding text/list/table structure.
plain = re.sub(r'<w:p><w:r><w:drawing>.*?</w:drawing></w:r></w:p>', '', source, flags=re.S)
head = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>DOCX import 🙂 é</w:t></w:r><w:hyperlink r:id="web"><w:r><w:t> linked</w:t></w:r></w:hyperlink></w:p>'
plain = plain.replace('<w:body>', '<w:body>'+head)
loss = plain.replace('</w:body>', '<w:sdt><w:sdtContent><w:p><w:r><w:t>opaque retained</w:t></w:r></w:p></w:sdtContent></w:sdt></w:body>')
media_rels = rels.replace('</Relationships>', f'<Relationship Id="img" Type="{R}/image" Target="media/pixel.png"/></Relationships>')
def package(document, relationships=rels, extras=()):
    b=io.BytesIO()
    with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_STORED) as z:
        for name,data in [('[Content_Types].xml',ct),('_rels/.rels',root),('word/document.xml',document),('word/numbering.xml',numbering),('word/_rels/document.xml.rels',relationships),*extras]:
            info=zipfile.ZipInfo(name,(2026,1,1,0,0,0));z.writestr(info,data)
    return b.getvalue()
pixel=pathlib.Path('fixtures/formats/docx/probe/pixel.png').read_bytes()
fixtures={'supported':package(plain),'loss':package(loss),'media':package(source,media_rels,[('word/media/pixel.png',pixel)]),'corrupt':b'PK\x03\x04not-a-zip','hostile':package(plain,extras=[('../escape.xml','forbidden')]),'nodes':package(plain.replace('</w:body>','<w:p><w:r><w:t>overflow</w:t></w:r></w:p>'*130+'</w:body>'))}
manifest={}
for name,data in fixtures.items():
    (out/(name+'.docx')).write_bytes(data)
    manifest[name]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
# Independently pin exact semantic facts from original XML, not importer output.
tree=ET.fromstring(plain)
expected={'paragraphTexts':[''.join(p.itertext()).strip() for p in tree.findall('./{'+W+'}body/{'+W+'}p')], 'tableCells':[['A','','é🙂','link']], 'bold':'DOCX import 🙂 é', 'link':'https://example.test/', 'listTexts':['Three','nested 🙂','Four']}
assert expected['paragraphTexts'][0]=='DOCX import 🙂 é linked'
assert not tree.findall('.//{'+W+'}drawing')
manifest['expected']=expected
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'fixtures':len(fixtures),'hashes':{k:v['sha256'] for k,v in manifest.items() if k!='expected'}}))
