"""Independent generated-artifact inspection only. No runtime PDF import API."""
import hashlib, io, json, pathlib, sys, unicodedata
import fitz
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ContentStream
from fontTools.ttLib import TTFont


def inspect(data):
    reader = PdfReader(io.BytesIO(data))
    assert len(reader.pages) == 2, 'page count'
    root = reader.trailer['/Root']
    assert '/StructTreeRoot' in root, 'missing semantic tags'
    tree = root['/StructTreeRoot']
    children = tree['/K']
    # A document wrapper is legal; count leaf paragraph structure instead of
    # assuming a particular writer's object numbering or compression choices.
    tags = []
    def walk(value):
        if isinstance(value, list):
            for item in value:
                walk(item)
        elif hasattr(value, 'get_object'):
            obj = value.get_object()
            if hasattr(obj, 'get'):
                if obj.get('/S'):
                    tags.append(str(obj['/S']))
                if obj.get('/K') is not None:
                    walk(obj['/K'])
    walk(children)
    assert tags.count('/P') == 9, ('paragraph tags', tags)
    font_names = set()
    embedded = []
    texts = []
    actual_text = []
    for page in reader.pages:
        texts.append(unicodedata.normalize('NFC', page.extract_text()))
        marked_stack = []
        for operands, operator in ContentStream(page['/Contents'], reader).operations:
            if operator == b'BDC':
                has_actual = len(operands) == 2 and hasattr(operands[1], 'get') and operands[1].get('/ActualText') is not None
                if has_actual and not any(marked_stack):
                    actual_text.append(str(operands[1]['/ActualText']))
                marked_stack.append(has_actual)
            elif operator == b'BMC':
                marked_stack.append(False)
            elif operator == b'EMC':
                assert marked_stack, 'unbalanced marked content'
                marked_stack.pop()
        assert not marked_stack, 'unclosed marked content'
        assert '/Annots' not in page, 'unexpected interactive content'
        for ref in page['/Resources']['/Font'].values():
            font = ref.get_object()
            font_names.add(str(font['/BaseFont']).split('+')[-1])
            assert '/ToUnicode' in font, 'missing selectable text map'
            descendants = font.get('/DescendantFonts', [font])
            for desc in descendants:
                obj = desc.get_object()['/FontDescriptor']
                key = '/FontFile2' if '/FontFile2' in obj else '/FontFile3'
                stream = obj[key].get_data()
                assert len(stream) > 100, 'missing embedded font bytes'
                embedded.append(hashlib.sha256(stream).hexdigest())
    assert font_names == {'NotoSans-Regular', 'NotoNaskhArabic-Regular'}, font_names
    assert 'PDF candidate qualification' in texts[0]
    assert 'Café - exact approved fonts' in texts[0]
    assert actual_text == ['PDF candidate qualification', 'Cafe\u0301 - exact approved fonts',
                          'لا لَا العربية', '#read("/private/secret") {literal}',
                          'Fixed line placement; no automatic wrapping',
                          'Second page - bounded layout probe', 'Cell A          Cell B',
                          'Cell C          Cell D', 'End of the tiny trusted fixture'], actual_text
    assert any(c in texts[0] for c in 'العربية'), 'Arabic text missing'
    assert 'Second page - bounded layout probe' in texts[1]
    assert 'End of the tiny trusted fixture' in texts[1]
    assert '/OpenAction' not in root and '/AA' not in root and '/AcroForm' not in root
    rendered = fitz.open(stream=data, filetype='pdf')
    assert '#read("/private/secret") {literal}' in rendered[0].get_text(), 'literal text changed'
    for page in rendered:
        spans = [s for b in page.get_text('dict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans']]
        assert spans, 'zero rendered text spans'
        for span in spans:
            rect = fitz.Rect(span['bbox'])
            assert rect.x0 >= 0 and rect.y0 >= 0 and rect.x1 <= page.rect.width and rect.y1 <= page.rect.height, ('clipped text', span)
    return dict(pages=2, paragraphTags=tags.count('/P'), fontNames=sorted(font_names),
                embeddedSubsetHashes=sorted(set(embedded)), text=texts, logicalActualText=actual_text,
                extractorObservation='pypdf may omit the leading # following an RTL run; MuPDF literal text and independent ActualText are checked exactly')


if __name__ == '__main__':
    output, fonts = map(pathlib.Path, sys.argv[1:])
    data = (output / 'cold/output.pdf').read_bytes()
    result = inspect(data)
    warm = inspect((output / 'warm/output.pdf').read_bytes())
    assert result['text'] == warm['text'], 'cold/warm semantic divergence'
    rejected = 0
    for variant in ('tags', 'font'):
        r = PdfReader(io.BytesIO(data))
        w = PdfWriter()
        w.clone_document_from_reader(r)
        if variant == 'tags':
            del w.root_object['/StructTreeRoot']
        else:
            for page in w.pages:
                for f in page['/Resources']['/Font'].values():
                    font = f.get_object()
                    for d in font.get('/DescendantFonts', [font]):
                        desc = d.get_object()['/FontDescriptor']
                        for key in ('/FontFile2', '/FontFile3'):
                            if key in desc:
                                del desc[key]
        b = io.BytesIO()
        w.write(b)
        try:
            inspect(b.getvalue())
        except (AssertionError, KeyError):
            rejected += 1
        else:
            raise AssertionError('oracle accepted mutation: ' + variant)
    assert rejected == 2
    result['negativeMutationsRejected'] = rejected
    result['fontProvenance'] = {}
    for name in ('NotoSans-Regular.ttf', 'NotoNaskhArabic-Regular.ttf'):
        font = TTFont(fonts / name)
        result['fontProvenance'][name] = dict(
            sha256=hashlib.sha256((fonts / name).read_bytes()).hexdigest(),
            versions=sorted(set(n.toUnicode() for n in font['name'].names if n.nameID == 5)),
            fsType=font['OS/2'].fsType, coverageCodepoints=len(font.getBestCmap()))
        assert font['OS/2'].fsType == 0, 'font embedding restriction'
    result['validationTools'] = dict(pypdf=__import__('pypdf').__version__, pymupdf=fitz.VersionBind,
                                    fonttools=__import__('fontTools').__version__)
    doc = fitz.open(stream=data, filetype='pdf')
    for i, page in enumerate(doc):
        page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False).save(output / ('page-%d.png' % (i+1)))
    (output / 'inspection.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(dict(pages=2, paragraphs=9, negativeMutationsRejected=rejected)))
