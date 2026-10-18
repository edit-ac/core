"""Independent stdlib csv oracle and dialect round-trip, only local fixture bytes."""
import csv, io, json, pathlib, sys
output=pathlib.Path(sys.argv[1]); fixtures=pathlib.Path('fixtures/formats/table-text')
expected=json.loads((fixtures/'expected.json').read_text())
results=[]
for name,delimiter,ending in [('quoted.csv',',','\n'),('quoted.tsv','\t','\r\n')]:
    with (fixtures/name).open(encoding='utf-8',newline='') as f:
        rows=list(csv.reader(f,delimiter=delimiter,quotechar='"',doublequote=True,strict=True))
    observed=json.loads((output/f'observed-{name}.json').read_text())
    assert observed==rows==expected[name]
    stream=io.StringIO(newline='')
    # Quote all fields so LF in a CRLF-delimited quoted TSV stays unambiguous.
    csv.writer(stream,delimiter=delimiter,quotechar='"',doublequote=True,lineterminator=ending,quoting=csv.QUOTE_ALL).writerows(observed)
    encoded=stream.getvalue()
    assert list(csv.reader(io.StringIO(encoded,newline=''),delimiter=delimiter,strict=True))==expected[name]
    (output/f'roundtrip-{name}').write_bytes(encoded.encode('utf-8'))
    # Negative oracle: exact whitespace, quotes, multiline and formula cells matter.
    for r,c in [(1,0),(1,1),(2,1),(2,2)]:
        perturbed=[row[:] for row in observed];perturbed[r][c]+='changed'
        assert perturbed!=expected[name]
    results.append({'fixture':name,'rows':len(rows),'cells':sum(map(len,rows)),'mutationsRejected':4})
(output/'independent-reference.json').write_text(json.dumps({'python':sys.version,'codec':'stdlib csv','results':results},indent=2)+'\n')
print('Independent CSV/TSV exact-cell and dialect round-trip oracles passed (2 fixtures, 8 mutations)')
