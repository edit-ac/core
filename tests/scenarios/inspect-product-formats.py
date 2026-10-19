"""Independent readers for files emitted by the installed task product."""
import csv
import json
import pathlib
import sys
import zipfile
import xml.etree.ElementTree as ET

path = pathlib.Path(sys.argv[1])
format = path.suffix[1:]
expected = 'Converted task'
if format in ('csv', 'tsv'):
    assert b'\r' not in path.read_bytes(), 'The selected LF dialect must be retained'
    with path.open(newline='') as stream:
        rows = list(csv.reader(stream, delimiter=',' if format == 'csv' else '\t'))
    assert rows == [['Task', 'State'], ['Example', 'Ready']], rows
    print(json.dumps({'format':format,'reader':'Python csv','rows':rows,'passed':True}))
    sys.exit(0)
if format == 'pdf':
    import fitz
    import pypdf
    assert fitz.VersionBind == '1.26.5'
    assert pypdf.__version__ == '6.1.1'
    with fitz.open(path) as document:
        assert len(document) >= 1
        assert expected in ''.join(page.get_text() for page in document)
    reader = pypdf.PdfReader(path, strict=True)
    assert len(reader.pages) >= 1
    assert '/StructTreeRoot' in reader.trailer['/Root']
else:
    with zipfile.ZipFile(path) as package:
        assert package.testzip() is None
        if format == 'docx':
            source = ET.fromstring(package.read('word/document.xml'))
            text = ''.join(source.itertext())
        elif format == 'odt':
            assert package.read('mimetype') == b'application/vnd.oasis.opendocument.text'
            source = ET.fromstring(package.read('content.xml'))
            namespace = '{urn:oasis:names:tc:opendocument:xmlns:text:1.0}'
            # ODF encodes significant spaces as elements, rather than XML text.
            for node in source.iter():
                if node.tag == namespace + 's':
                    node.text = ' ' * int(node.get(namespace + 'c', '1'))
                elif node.tag == namespace + 'tab':
                    node.text = '\t'
                elif node.tag == namespace + 'line-break':
                    node.text = '\n'
            text = ''.join(source.itertext())
        elif format == 'epub':
            assert package.read('mimetype') == b'application/epub+zip'
            text = ''.join(''.join(ET.fromstring(package.read(name)).itertext()) for name in package.namelist() if name.endswith('.xhtml'))
        else:
            raise AssertionError('Unknown artifact type')
        assert expected in text, text
print(json.dumps({'format':format,'reader':'PyMuPDF 1.26.5 / pypdf 6.1.1' if format=='pdf' else 'Python ZIP/XML','expectedText':expected,'passed':True}))
