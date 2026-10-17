"""Independent generated-artifact oracles. Never installed as a PDF importer."""
import hashlib
import io
import json
import pathlib
import sys
import unicodedata
import pypdf
from pypdf.generic import ContentStream, DecodedStreamObject, NameObject, TextStringObject
import fitz
from importlib.machinery import SourceFileLoader
stream_text = SourceFileLoader("pdf_logical_text", str(pathlib.Path(__file__).with_name("pdf-logical-text.py"))).load_module()


def logical(data, expected):
    reader = pypdf.PdfReader(io.BytesIO(data), strict=True)
    root = reader.trailer['/Root']
    assert '/StructTreeRoot' in root and root['/MarkInfo']['/Marked']
    for key in ('/OpenAction', '/AA', '/AcroForm'):
        assert key not in root
    actual, actual_by_id = stream_text.marked_text(reader)
    paragraphs = []
    paragraph_count = 0
    def tags(item):
        nonlocal paragraph_count
        if hasattr(item, 'get_object'):
            item = item.get_object()
        if isinstance(item, (list, pypdf.generic.ArrayObject)):
            for child in item:
                tags(child)
        elif hasattr(item, 'get'):
            if item.get('/S') == '/P':
                paragraph_count += 1
                paragraphs.append(item)
            if '/K' in item:
                tags(item['/K'])
    tags(root['/StructTreeRoot']['/K'])
    assert paragraph_count == len(expected), (paragraph_count, len(expected))
    font_names = set()
    for page in reader.pages:
        for ref in page['/Resources']['/Font'].values():
            font = ref.get_object()
            assert '/ToUnicode' in font
            font_names.add(str(font['/BaseFont']).split('+')[-1])
            for desc in font['/DescendantFonts']:
                descriptor = desc.get_object()['/FontDescriptor']
                key = '/FontFile2' if '/FontFile2' in descriptor else '/FontFile3'
                assert len(descriptor[key].get_data()) > 100
    assert ''.join(actual) == ''.join(expected), 'logical source text/reading order changed'
    tagged = []
    for paragraph in paragraphs:
        parts = []
        for child in paragraph['/K']:
            if isinstance(child, int):
                key = (paragraph.raw_get('/Pg').idnum, int(child))
            else:
                child = child.get_object()
                key = (child.raw_get('/Pg').idnum, int(child['/MCID']))
            parts.append(actual_by_id[key])
        tagged.append(''.join(parts))
    assert tagged == expected, 'tagged semantic reading order differs from source paragraphs'
    assert font_names == {'NotoSans-Regular', 'NotoNaskhArabic-Regular'}
    assert len(reader.pages) >= 4
    return {'pages': len(reader.pages), 'paragraphs': paragraph_count, 'logicalChunks': len(actual),
            'logicalSha256': hashlib.sha256(''.join(actual).encode()).hexdigest(), 'fonts': sorted(font_names)}


def visual(data, expected, root=None):
    doc = fitz.open(stream=data, filetype='pdf')
    latin = []
    arabic_chars = 0
    spans_count = 0
    for i, page in enumerate(doc):
        assert page.rect.width == 420 and page.rect.height == 360
        spans = [s for b in page.get_text('dict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans']]
        assert spans, ('missing visible page', i)
        for span in spans:
            rect = fitz.Rect(span['bbox'])
            assert rect.x0 >= 20 and rect.y0 >= 20 and rect.x1 <= 400 and rect.y1 <= 340, ('clipped text', i, span)
            text = span['text']
            if any('\u0600' <= c <= '\u06ff' for c in text):
                arabic_chars += len(text.strip())
            else:
                latin.append(text)
        spans_count += len(spans)
        pix = page.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False)
        assert min(pix.samples) < 100, ('blank raster', i)
        if root:
            pix.save(str(root / ('page-%02d.png' % (i + 1))))
    def flat(s):
        return ''.join(unicodedata.normalize('NFC', s).split())
    expected_latin = ''.join(s for s in expected if not any('\u0600' <= c <= '\u06ff' for c in s))
    assert flat(''.join(latin)) == flat(expected_latin), 'visible Latin glyphs/lines/order differ'
    assert arabic_chars >= 8, 'Arabic glyphs missing'
    return {'pages': len(doc), 'visibleSpans': spans_count, 'arabicVisibleChars': arabic_chars}


def write(reader):
    writer = reader
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def replace_stream(page, content):
    # A ContentStream retains its source indirect reference. Give the writer a
    # fresh stream rather than allowing clone deduplication to select the source.
    replacement = DecodedStreamObject()
    replacement.set_data(content.get_data())
    page.replace_contents(replacement)


def main(root, fixture):
    data = (root / 'text-publication.pdf').read_bytes()
    expected = json.loads(fixture.read_text())
    result = {'logical': logical(data, expected), 'visual': visual(data, expected, root)}
    mutations = []
    reader = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    stream = ContentStream(reader.pages[0]['/Contents'], reader)
    for args, op in stream.operations:
        if op == b'BDC' and hasattr(args[1], 'get') and '/ActualText' in args[1]:
            args[1][NameObject('/ActualText')] = TextStringObject('PERTURBED')
            break
    else:
        raise AssertionError('no ActualText mutation target')
    replace_stream(reader.pages[0], stream)
    mutations.append(('perturbed-logical-text', write(reader), logical))
    reader = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    reader.pages[0].add_transformation(pypdf.Transformation().translate(tx=500, ty=0))
    shifted = write(reader)
    logical(shifted, expected)  # logical text alone deliberately accepts clipping
    mutations.append(('clipping-with-intact-logical-text', shifted, visual))
    reader = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    stream = ContentStream(reader.pages[0]['/Contents'], reader)
    before = len(stream.operations)
    for index, (_, op) in enumerate(stream.operations):
        if op in (b'Tj', b'TJ'):
            del stream.operations[index]
            break
    assert len(stream.operations) == before - 1
    replace_stream(reader.pages[0], stream)
    missing_line = write(reader)
    logical(missing_line, expected)
    mutations.append(('missing-drawn-line-with-intact-logical-text', missing_line, visual))
    short = fitz.open(stream=data, filetype='pdf')
    short.delete_page(1)
    mutations.append(('missing-page', short.tobytes(), logical))
    reader = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    groups = reader.root_object['/StructTreeRoot']['/K'][0].get_object()['/K']
    groups[0], groups[1] = groups[1], groups[0]
    mutations.append(('changed-tagged-reading-order', write(reader), logical))
    reasons = {}
    warnings = {}
    required_reason = {
        'perturbed-logical-text': 'logical source text',
        'clipping-with-intact-logical-text': 'missing visible page',
        'missing-drawn-line-with-intact-logical-text': 'visible Latin glyphs',
        'missing-page': 'logical source text',
        'changed-tagged-reading-order': 'tagged semantic reading order',
    }
    for name, changed, oracle in mutations:
        (root / (name + '.pdf')).write_bytes(changed)
        fitz.TOOLS.mupdf_warnings()
        mutation_doc = fitz.open(stream=changed, filetype='pdf')
        for page in mutation_doc:
            page.get_text()
        warning = fitz.TOOLS.mupdf_warnings()
        warnings[name] = warning
        assert all('Actualtext with no position' in line or 'repeated' in line
                   for line in warning.splitlines()), ('malformed mutation fixture', name, warning)
        try:
            oracle(changed, expected)
        except (AssertionError, KeyError) as error:
            reasons[name] = str(error)
            assert required_reason[name] in str(error), ('wrong rejection reason', name, str(error))
        else:
            raise AssertionError('mutation accepted: ' + name)
    result['rejectionReasons'] = reasons
    result['mutationWarnings'] = warnings
    result['rejectedMutations'] = [m[0] for m in mutations]
    (root / 'independent-inspection.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main(*map(pathlib.Path, sys.argv[1:]))
