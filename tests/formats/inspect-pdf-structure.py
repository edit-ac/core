"""Independent generated-PDF logical, table, image and render oracles.

Reads publication artifacts only; fixture expectations do not add PDF import.
Exporter layout reports are deliberately not used as oracle truth.
"""
import io
import json
import pathlib
import sys
import hashlib
import unicodedata
import pypdf
from pypdf.generic import ContentStream, NameObject, TextStringObject, ArrayObject, DecodedStreamObject
import fitz
from importlib.machinery import SourceFileLoader
stream_text = SourceFileLoader("pdf_logical_text", str(pathlib.Path(__file__).with_name("pdf-logical-text.py"))).load_module()


def flat(text):
    return ''.join(unicodedata.normalize('NFC', text).split())


def children(item):
    item = item.get_object() if hasattr(item, 'get_object') else item
    if isinstance(item, (list, ArrayObject)):
        return item
    if not hasattr(item, 'get'):
        return []
    value = item.get('/K', [])
    return value if isinstance(value, (list, ArrayObject)) else [value]


def logical(data, fixture):
    reader = pypdf.PdfReader(io.BytesIO(data), strict=True)
    root = reader.trailer['/Root']
    assert '/StructTreeRoot' in root and root['/MarkInfo']['/Marked']
    assert not any(k in root for k in ('/AA', '/OpenAction', '/AcroForm'))
    _, actual = stream_text.marked_text(reader)
    def text(item, pg=None):
        item = item.get_object() if hasattr(item, 'get_object') else item
        if isinstance(item, int):
            return actual.get((pg, int(item)), '')
        if isinstance(item, (list, ArrayObject)):
            return ''.join(text(c, pg) for c in item)
        if '/Pg' in item:
            pg = item.raw_get('/Pg').idnum
        if item.get('/Type') == '/MCR':
            return actual.get((pg, int(item['/MCID'])), '')
        return ''.join(text(c, pg) for c in children(item))
    nodes = []
    def walk(item):
        item = item.get_object() if hasattr(item, 'get_object') else item
        if isinstance(item, (list, ArrayObject)):
            for c in item:
                walk(c)
        elif hasattr(item, 'get'):
            if '/S' in item:
                nodes.append(item)
            for c in children(item):
                walk(c)
    walk(root['/StructTreeRoot']['/K'])
    tables = [n for n in nodes if n.get('/S') == '/Table']
    assert len(tables) == 1, 'missing semantic table'
    rows = [c.get_object() for c in children(tables[0])]
    assert all(r.get('/S') == '/TR' for r in rows), 'table row semantics lost'
    assert len(rows) == len(fixture['rows']), 'table row count/order changed'
    for index, (row, expected) in enumerate(zip(rows, fixture['rows'])):
        cells = [c.get_object() for c in children(row)]
        assert len(cells) == len(expected), 'table cell count changed'
        for cell, want in zip(cells, expected):
            assert cell.get('/S') == ('/TH' if index == 0 else '/TD'), 'table header/cell semantics lost'
            assert text(cell) == want['text'], 'table logical text/order changed'
            if index == 0:
                attrs = cell.get('/A', {})
                attrs = attrs[0] if isinstance(attrs, (list, ArrayObject)) else attrs
                assert attrs.get('/Scope') == '/Column', 'header scope lost'
    figures = [n for n in nodes if n.get('/S') == '/Figure']
    assert len(figures) == 1 and str(figures[0].get('/Alt')) == fixture['image']['alt'], 'image alternative text lost'
    assert text(figures[0]) == fixture['image']['caption'], 'image caption changed'
    paragraphs = [text(n) for n in nodes if n.get('/S') == '/P']
    assert [p for p in paragraphs if p] == [fixture['before'], fixture['after']], 'surrounding text/order changed'
    top = [c.get_object() for c in children(root['/StructTreeRoot'])]
    # Krilla can wrap top-level children in a Document tag.
    if len(top) == 1 and top[0].get('/S') == '/Document':
        top = [c.get_object() for c in children(top[0])]
    assert [n.get('/S') for n in top if n.get('/S') != '/P' or text(n)] == ['/P', '/Table', '/Figure', '/P'], 'publication reading order changed'
    return {'pages': len(reader.pages), 'rows': len(rows), 'cells': sum(len(r) for r in fixture['rows']), 'figures': len(figures)}


def visual(data, fixture, original, output=None):
    doc = fitz.open(stream=data, filetype='pdf')
    all_cells = []
    image_rects = []
    latin = []
    arabic = 0
    fonts = set()
    borders = 0
    for number, page in enumerate(doc):
        assert page.rect.width == 420 and page.rect.height == 360
        spans = [s for b in page.get_text('dict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans']]
        assert spans, 'missing visible page'
        for span in spans:
            r = fitz.Rect(span['bbox'])
            assert 20 <= r.x0 <= r.x1 <= 400 and 20 <= r.y0 <= r.y1 <= 340, 'clipped visible text'
            fonts.add(span['font'])
            if any('\u0600' <= c <= '\u06ff' for c in span['text']):
                arabic += len(span['text'].strip())
            else:
                latin.append(span['text'])
        boxes = sorted([d['rect'] for d in page.get_drawings() if abs(d['width'] - .5) < .01], key=lambda r: (round(r.y0, 2), r.x0))
        assert len(boxes) % 2 == 0, 'incomplete visible table row'
        for offset in range(0, len(boxes), 2):
            left, right = boxes[offset:offset + 2]
            assert abs(left.y0 - right.y0) < .01 and abs(left.y1 - right.y1) < .01, 'split table row'
            assert abs(left.x0 - 28) < .01 and abs(right.x1 - 392) < .01, 'table border outside declared columns'
            assert abs(left.x1 - right.x0) < .01, 'nonrectangular table'
            assert 28 <= left.y0 < left.y1 <= 332, 'clipped table border'
            for box in (left, right):
                # Extract only the generated cell's geometry; reject glyphs that
                # escape the rectangle even if the tag still has correct text.
                chosen = [s for s in spans if fitz.Rect(s['bbox']).intersects(box)]
                for s in chosen:
                    r = fitz.Rect(s['bbox'])
                    assert r.x0 >= box.x0 + 5.5 and r.x1 <= box.x1 - 5.5 and r.y0 >= box.y0 and r.y1 <= box.y1, 'cell glyph clipping/overlap'
                all_cells.append(''.join(s['text'] for s in chosen))
            borders += 2
        for info in page.get_image_info(xrefs=True):
            image_rects.append((number, fitz.Rect(info['bbox'])))
            pix = fitz.Pixmap(doc, info['xref'])
            assert (pix.width, pix.height) == (fixture['image']['width'], fixture['image']['height']), 'image dimensions changed'
            source = fitz.Pixmap(str(original))
            assert pix.samples == source.samples, 'original image pixels changed'
            r = fitz.Rect(info['bbox'])
            assert r.x0 == 28 and r.x1 <= 392 and 28 <= r.y0 < r.y1 <= 332, 'image clipped'
            assert abs(r.width - 120) < .01 and abs(r.height - 60) < .01, 'image aspect/size changed'
            # The embedded samples alone do not prove painting. Check page raster.
            raster = page.get_pixmap(alpha=False)
            for fraction, color in [(1/6, (240,32,32)), (1/2,(32,200,64)), (5/6,(32,64,240))]:
                point = (int(r.x0 + r.width * fraction), int(r.y0 + r.height / 2))
                assert max(abs(a-b) for a,b in zip(raster.pixel(*point),color)) <= 2, 'image not visibly painted'
        if output:
            page.get_pixmap(matrix=fitz.Matrix(1.5,1.5), alpha=False).save(str(output / ('structure-page-%02d.png' % (number+1))))
    expected = [c['text'] for row in fixture['rows'] for c in row]
    assert len(all_cells) == len(expected), 'visible table cell count changed'
    for got, want in zip(all_cells, expected):
        if not any('\u0600' <= c <= '\u06ff' for c in want):
            assert flat(got) == flat(want), 'visible cell text/order changed'
    want_latin = fixture['before'] + ''.join(t for t in expected if not any('\u0600' <= c <= '\u06ff' for c in t)) + fixture['image']['caption'] + fixture['after']
    assert flat(''.join(latin)) == flat(want_latin), 'visible publication text/order changed'
    assert arabic >= 8, 'Arabic cell glyphs missing'
    assert len(image_rects) == 1, 'visible original image missing'
    assert 'NotoSans-Bold' in fonts and 'NotoNaskhArabic-Regular' in fonts
    return {'pages': len(doc), 'borders': borders, 'images': len(image_rects), 'arabicVisibleChars': arabic, 'fonts': sorted(fonts)}


def write(writer):
    out = io.BytesIO(); writer.write(out); return out.getvalue()


def main(output, fixture_path, original):
    fixture = json.loads(fixture_path.read_text())
    data = (output / 'structure-publication.pdf').read_bytes()
    result = {'logical': logical(data, fixture), 'visual': visual(data, fixture, original, output)}
    mutations = []
    def find(item, role):
        item = item.get_object() if hasattr(item, 'get_object') else item
        if hasattr(item, 'get') and item.get('/S') == role:
            return item
        for c in children(item):
            found = find(c, role)
            if found is not None:
                return found
        return None
    writer = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    table = find(writer.root_object['/StructTreeRoot'], '/Table')
    table['/K'][1], table['/K'][2] = table['/K'][2], table['/K'][1]
    mutations.append(('table-row-order', write(writer), 'logical', 'table logical text/order'))
    writer = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    find(writer.root_object['/StructTreeRoot'], '/TH')[NameObject('/S')] = NameObject('/TD')
    mutations.append(('table-header-lost', write(writer), 'logical', 'header/cell semantics'))
    writer = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    find(writer.root_object['/StructTreeRoot'], '/Figure')[NameObject('/Alt')] = TextStringObject('wrong alternative')
    mutations.append(('image-alt-lost', write(writer), 'logical', 'alternative text'))
    writer = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    removed = False
    for page in writer.pages:
        stream = ContentStream(page['/Contents'], writer)
        for index, (_, op) in enumerate(stream.operations):
            if op == b'Do':
                del stream.operations[index]; removed = True
                replacement = DecodedStreamObject(); replacement.set_data(stream.get_data()); page.replace_contents(replacement)
                break
        if removed: break
    assert removed
    changed = write(writer); logical(changed, fixture)
    mutations.append(('image-paint-lost', changed, 'visual', 'visible original image missing'))
    writer = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    writer.pages[0].add_transformation(pypdf.Transformation().translate(tx=15, ty=0))
    changed = write(writer); logical(changed, fixture)
    mutations.append(('table-clipping', changed, 'visual', 'table border outside declared columns'))
    writer = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    page = writer.pages[0]
    stream = ContentStream(page['/Contents'], writer)
    text_ops = [i for i, (_, op) in enumerate(stream.operations) if op in (b'Tj', b'TJ')]
    assert len(text_ops) >= 2
    del stream.operations[text_ops[1]]
    replacement = DecodedStreamObject(); replacement.set_data(stream.get_data()); page.replace_contents(replacement)
    changed = write(writer); logical(changed, fixture)
    mutations.append(('cell-paint-lost', changed, 'visual', 'visible cell text/order changed'))
    result['rejectedMutations'] = []
    result['rejectionReasons'] = {}
    for name, changed, oracle, reason in mutations:
        (output / (name + '.pdf')).write_bytes(changed)
        fitz.TOOLS.mupdf_warnings()
        probe = fitz.open(stream=changed, filetype='pdf')
        for page in probe: page.get_text()
        warnings = fitz.TOOLS.mupdf_warnings()
        assert all('Actualtext with no position' in s or 'repeated' in s for s in warnings.splitlines()), ('malformed mutation', name, warnings)
        try:
            logical(changed, fixture) if oracle == 'logical' else visual(changed, fixture, original)
        except (AssertionError, KeyError) as error:
            assert reason in str(error), ('wrong rejection reason', name, str(error))
            result['rejectedMutations'].append(name); result['rejectionReasons'][name] = str(error)
        else:
            raise AssertionError('mutation accepted: ' + name)
    result['originalSha256'] = hashlib.sha256(original.read_bytes()).hexdigest()
    (output / 'structure-inspection.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
