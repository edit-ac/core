"""Independent stdlib package/XML inspection of the actual Rust writer artifact."""
import sys, zipfile, xml.etree.ElementTree as ET
from pathlib import Path
p = Path(sys.argv[1]); expected_png = Path(sys.argv[2]).read_bytes()
w = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
r = '{http://schemas.openxmlformats.org/package/2006/relationships}'
with zipfile.ZipFile(p) as z:
    assert len(z.namelist()) == len(set(z.namelist()))
    for name in z.namelist():
        assert not name.startswith('/') and '..' not in name.split('/')
        if name.endswith(('.xml', '.rels')): ET.fromstring(z.read(name))
    tree = ET.fromstring(z.read('word/document.xml'))
    paragraphs = [''.join(t.text or '' for t in p.iter(w+'t')) for p in tree.iter(w+'p')]
    assert paragraphs[:2] == [' A & B 🦀 e\u0301 ', '第二段'], paragraphs
    run = next(tree.iter(w+'r'))
    assert run.find(w+'rPr/'+w+'b') is not None
    assert run.find(w+'rPr/'+w+'i') is not None
    rels = ET.fromstring(z.read('word/_rels/document.xml.rels'))
    images = [x for x in rels if x.attrib['Type'].endswith('/image')]
    assert len(images) == 1 and images[0].attrib.get('TargetMode') != 'External'
    assert z.read('word/'+images[0].attrib['Target']) == expected_png
    assert not any('vbaProject' in n or 'embeddings/' in n for n in z.namelist())
print('independent package/XML: Unicode, spaces, marks, original PNG and internal relationship passed')
