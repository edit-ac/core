"""Independent standard-library CSV reader and committed rich-table oracle."""
import csv, hashlib, io

def inspect(payload, original, dialect):
    assert payload['profile'] == ('edit-ac-csv-v1' if dialect['delimiter']=='comma' else 'edit-ac-tsv-v1')
    assert payload['originalSha256'] == hashlib.sha256(original).hexdigest()
    text = original.decode('utf-8-sig' if dialect['encoding']=='utf8-bom' else 'utf-8')
    rows = list(csv.reader(io.StringIO(text, newline=''), delimiter=',' if dialect['delimiter']=='comma' else '\t', strict=True))
    assert rows and all(len(row)==len(rows[0]) for row in rows)
    table_blocks = [b for b in payload['snapshotBlocks'] if b['attributes'] and b['attributes'][0]=='module:editac.table']
    actual = [b['attributes'] for b in table_blocks]
    for b in payload['snapshotBlocks']:
        if b not in table_blocks:
            assert b['attributes']==['paragraph'] and all(r['text']=='' for r in b['runs'])
    assert len(actual)==1 and actual[0][:2]==['module:editac.table',2]
    table=actual[0][2]
    assert table['source']==text
    assert table['alignments']==['none']*len(rows[0])
    assert len(table['rows'])==len(rows)
    for i,(expected, observed) in enumerate(zip(rows,table['rows'])):
        assert len(expected)==len(observed)
        for cell, value in zip(expected, observed):
            assert value['rowSpan']==value['columnSpan']==1
            assert value['header'] is (dialect['header']=='first-row' and i==0)
            assert value['paragraphs']==[{'style':['paragraph'],'runs':[[cell,[]]]}]
    prepared=[b['attributes'] for b in payload['preparedBlocks'] if b['attributes']]
    assert prepared==actual
    report=payload['report']
    assert report==dict(diagnostics=[],scannedBytes=len(original),rows=len(rows),columns=len(rows[0]),cells=sum(map(len,rows)),
                       utf16Units=sum(len(c.encode('utf-16-le'))//2 for row in rows for c in row),
                       headerRows=int(dialect['header']=='first-row'),bomRemoved=original.startswith(b'\xef\xbb\xbf'))
    fallback='\n'.join('\t'.join(row) for row in rows)
    assert payload['text']==fallback
    assert [''.join(r['text'] for r in b['runs']) for b in table_blocks]==[fallback]
    assert payload['commits']==1 and payload['activeJobs']==payload['assets']==payload['networkCalls']==0
    assert all(payload[k] is True for k in ('undo','redo','reopen'))
    assert hashlib.sha256(bytes(payload['checkpoint'])).hexdigest()==payload['checkpointSha256']
    return rows
