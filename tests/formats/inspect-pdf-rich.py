"""Inspect generated rich PDFs only. No runtime reader or import capability."""
import io
import json
import pathlib
import sys
import unicodedata
import pypdf
from pypdf.generic import ContentStream, NameObject, TextStringObject, ArrayObject
import fitz
from importlib.machinery import SourceFileLoader
base = SourceFileLoader('text_oracle', str(pathlib.Path(__file__).with_name('inspect-pdf-export.py'))).load_module()


def expected(fixture):
    blocks = json.loads(json.dumps(fixture['blocks']))
    if fixture['initialText']:
        blocks[-1]['runs'].append({'text': fixture['initialText'], 'marks': []})
    return blocks


def inspect(data, fixture, root=None):
    reader = pypdf.PdfReader(io.BytesIO(data), strict=True)
    doc = fitz.open(stream=data, filetype='pdf')
    tree = reader.trailer['/Root']['/StructTreeRoot']
    for key in ['/OpenAction', '/AA', '/AcroForm']:
        assert key not in reader.trailer['/Root'], 'active root action'
    _, actual = base.stream_text.marked_text(reader)
    fonts = set()
    annotations = {}
    for number, page in enumerate(reader.pages):
        for font in page['/Resources']['/Font'].values():
            font = font.get_object()
            assert '/ToUnicode' in font
            fonts.add(str(font['/BaseFont']).split('+')[-1])
            for descendant in font['/DescendantFonts']:
                descriptor = descendant.get_object()['/FontDescriptor']
                assert any(k in descriptor and len(descriptor[k].get_data()) > 100 for k in ['/FontFile2', '/FontFile3'])
        for annotation in page.get('/Annots', []):
            a = annotation.get_object()
            assert a['/Subtype'] == '/Link' and '/AA' not in a, 'unsafe annotation'
            assert a['/A']['/S'] == '/URI', 'unsafe link action'
            uri = str(a['/A']['/URI'])
            assert uri in fixture['expectedLinks'], 'unexpected link target'
            x0, y0, x1, y1 = map(float, a['/Rect'])
            assert 28 <= x0 < x1 <= 392.1 and 24 <= y0 < y1 <= 340, 'link rectangle outside page'
            annotations[(page.indirect_reference.idnum, annotation.idnum)] = uri
    assert fonts == {'NotoSans-Regular', 'NotoSans-Bold', 'NotoSans-Italic', 'NotoSans-BoldItalic', 'NotoSansMono-Regular'}, fonts
    labels = []
    paragraphs = []
    headings = []
    links = {}
    codes = []
    lists = []
    def children(item):
        item = item.get_object() if hasattr(item, 'get_object') else item
        if isinstance(item, (list, ArrayObject)):
            return item
        k = item.get('/K', [])
        return k if isinstance(k, (list, ArrayObject)) else [k]
    def text(item, pg=None):
        item = item.get_object() if hasattr(item, 'get_object') else item
        if isinstance(item, int):
            return actual[(pg, int(item))]
        if isinstance(item, (list, ArrayObject)):
            return ''.join(text(c, pg) for c in item)
        if '/Pg' in item:
            pg = item.raw_get('/Pg').idnum
        if item.get('/Type') == '/OBJR':
            return ''
        if '/MCID' in item:
            return actual[(pg, int(item['/MCID']))]
        return ''.join(text(c, pg) for c in children(item))
    def walk(item, list_depth=0):
        item = item.get_object() if hasattr(item, 'get_object') else item
        if isinstance(item, (list, ArrayObject)):
            for c in item:
                walk(c, list_depth)
            return
        if not hasattr(item, 'get'):
            return
        role = str(item.get('/S', ''))
        if role == '/L':
            list_depth += 1
            lists.append((list_depth, len(children(item))))
        if role == '/Lbl':
            labels.append(text(item))
        if role == '/P' or role.startswith('/H'):
            paragraphs.append(text(item))
            if role != '/P':
                headings.append((role, text(item)))
        if role == '/Code':
            codes.append(text(item))
        if role == '/Link':
            refs = [c.get_object() for c in children(item) if hasattr(c, 'get_object')]
            objects = [c for c in refs if hasattr(c, 'get') and c.get('/Type') == '/OBJR']
            assert len(objects) == 1, 'missing link annotation association'
            obj = objects[0]
            key = (obj.raw_get('/Pg').idnum if '/Pg' in obj else item.raw_get('/Pg').idnum, obj.raw_get('/Obj').idnum)
            assert key in annotations, 'missing link annotation association'
            uri = annotations[key]
            links[uri] = links.get(uri, '') + text(item)
        walk(children(item), list_depth)
    walk(tree['/K'])
    blocks = expected(fixture)
    assert paragraphs == [''.join(r['text'] for r in b['runs']) for b in blocks], 'rich logical reading order'
    assert labels == fixture['expectedLabels'], 'list labels changed'
    assert lists == [(1, 2), (2, 1), (1, 1)], 'nested list structure changed'
    assert headings == [('/H' + str(b['heading']), ''.join(r['text'] for r in b['runs'])) for b in blocks if 'heading' in b], 'heading semantics changed'
    expected_links = {r['href']: r['text'] for b in blocks for r in b['runs'] if 'link' in r['marks']}
    assert links == expected_links, 'link text/target or annotation association changed'
    assert ''.join(codes) == ''.join(r['text'] for b in blocks for r in b['runs'] if 'code' in r['marks']), 'code tag changed'
    def flat(s):
        return ''.join(unicodedata.normalize('NFC', s).split())
    wanted = []
    label_index = 0
    for b in blocks:
        size = 28 - 2 * b['heading'] if 'heading' in b else 14
        if 'path' in b:
            label = fixture['expectedLabels'][label_index]
            wanted.extend((c, 'NotoSans-Regular', 14, False, False) for c in flat(label))
            label_index += 1
        for r in b['runs']:
            marks = r['marks']
            face = 'Mono-Regular' if 'code' in marks else '-BoldItalic' if 'bold' in marks and 'italic' in marks else '-Bold' if 'bold' in marks else '-Italic' if 'italic' in marks else '-Regular'
            wanted.extend((c, 'NotoSans' + face, size, 'underline' in marks or 'link' in marks, 'strike' in marks) for c in flat(r['text']))
    visible = []
    drawings_count = 0
    for number, page in enumerate(doc):
        assert page.rect.width == 420 and page.rect.height == 360
        strokes = []
        for drawing in page.get_drawings():
            for item in drawing['items']:
                if item[0] == 'l' and abs(item[1].y - item[2].y) < .1:
                    strokes.append((min(item[1].x, item[2].x), max(item[1].x, item[2].x), item[1].y))
        drawings_count += len(strokes)
        for b in page.get_text('rawdict')['blocks']:
            for line in b.get('lines', []):
                for span in line['spans']:
                    rect = fitz.Rect(span['bbox'])
                    assert rect.x0 >= 20 and rect.y0 >= 20 and rect.x1 <= 400 and rect.y1 <= 340, 'clipped rich text'
                    for char in span['chars']:
                        for c in flat(char['c']):
                            x, y = char['origin']
                            under = any(a - .5 <= x <= z + .5 and abs(dy - (y + 2)) < .2 for a, z, dy in strokes)
                            strike = any(a - .5 <= x <= z + .5 and abs(dy - (y - span['size'] * .3)) < .2 for a, z, dy in strokes)
                            visible.append((c, span['font'], round(span['size']), under, strike))
        pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
        assert min(pix.samples) < 100, 'blank rich page'
        if root:
            pix.save(str(root / ('rich-page-%02d.png' % (number + 1))))
    # MuPDF may expose an authored combining sequence as either decomposed or
    # composed characters. This fixture's same-face NFC text is checked separately.
    got_text = flat(''.join(v[0] for v in visible))
    assert got_text == ''.join(v[0] for v in wanted), 'visible rich text/labels/order changed'
    # Normalize per-span combining sequences while preserving style for each glyph.
    normalized = []
    for entry in visible:
        if unicodedata.combining(entry[0]) and normalized:
            previous = normalized.pop()
            normalized.append((unicodedata.normalize('NFC', previous[0] + entry[0]), *previous[1:]))
        else:
            normalized.append(entry)
    assert len(normalized) == len(wanted), 'rich glyph count'
    for got, want in zip(normalized, wanted):
        assert got[:3] == want[:3], ('rich font/size changed', got, want)
        if want[3]:
            assert got[3], ('missing underline decoration', got, want)
        if want[4]:
            assert got[4], ('missing strike decoration', got, want)
    return {'pages': len(doc), 'paragraphs': len(paragraphs), 'headings': headings, 'lists': lists, 'labels': labels,
            'annotations': len(annotations), 'links': links, 'fonts': sorted(fonts), 'visibleGlyphs': len(normalized), 'decorationLines': drawings_count}


def main(root, fixture_path):
    fixture = json.loads(fixture_path.read_text())
    data = (root / 'rich-publication.pdf').read_bytes()
    result = inspect(data, fixture, root)
    mutations = []
    writer = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    annotation = next(a.get_object() for p in writer.pages for a in p.get('/Annots', []))
    annotation['/A'][NameObject('/URI')] = TextStringObject('javascript:alert(1)')
    mutations.append(('unsafe-link-target', base.write(writer), 'unexpected link target'))
    writer = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    for page in writer.pages:
        page.pop(NameObject('/Annots'), None)
    mutations.append(('missing-link-annotations', base.write(writer), 'missing link annotation association'))
    writer = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    def change_heading(item):
        item = item.get_object() if hasattr(item, 'get_object') else item
        if isinstance(item, (list, ArrayObject)):
            return any(change_heading(c) for c in item)
        if not hasattr(item, 'get'):
            return False
        if item.get('/S') == '/H1':
            item[NameObject('/S')] = NameObject('/P')
            return True
        return change_heading(item.get('/K', []))
    assert change_heading(writer.root_object['/StructTreeRoot']['/K'])
    mutations.append(('heading-tag-lost', base.write(writer), 'heading semantics changed'))
    writer = pypdf.PdfWriter(clone_from=io.BytesIO(data))
    removed = 0
    for page in writer.pages:
        stream = ContentStream(page['/Contents'], writer)
        ops = []
        for args, op in stream.operations:
            if op == b'S':
                removed += 1
                op = b'n'
            ops.append((args, op))
        stream.operations = ops
        base.replace_stream(page, stream)
    assert removed > 0
    mutations.append(('visible-decorations-removed', base.write(writer), 'missing underline decoration'))
    reasons = {}
    for name, changed, reason in mutations:
        (root / (name + '.pdf')).write_bytes(changed)
        fitz.TOOLS.mupdf_warnings()
        valid = fitz.open(stream=changed, filetype='pdf')
        for page in valid:
            page.get_text()
        assert not fitz.TOOLS.mupdf_warnings(), 'malformed rich mutation: ' + name
        try:
            inspect(changed, fixture)
        except (AssertionError, KeyError) as error:
            reasons[name] = str(error)
            assert reason in str(error), ('wrong rich rejection reason', name, str(error))
        else:
            raise AssertionError('rich mutation accepted: ' + name)
    (root / 'rich-inspection.json').write_text(json.dumps({'inspection': result, 'rejectionReasons': reasons, 'rejectedMutations': list(reasons)}, indent=2) + '\n')


if __name__ == '__main__':
    main(*map(pathlib.Path, sys.argv[1:]))
