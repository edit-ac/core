"""Independent csv reader/writer oracle over generated artifacts only."""
import csv, io, json, pathlib, sys, hashlib
out=pathlib.Path(sys.argv[1])
expected=json.loads(pathlib.Path('fixtures/formats/table-text/expected.json').read_text())['quoted.csv']
safe=[['\'=1+1','\'+SUM(A1)',"'-2","'@x"],["'  =x","'\tcmd","'\ncmd","text"],["'safe","12"," é","🙂"]]
results=[]
for name,delimiter,ending,rows in [('exact.csv',',','\r\n',expected),('exact.tsv','\t','\n',expected),('safe.csv',',','\r\n',safe),('safe.tsv','\t','\r\n',safe)]:
    raw=(out/name).read_bytes()
    def inspect(data):
        try:
            observed=list(csv.reader(io.StringIO(data.decode('utf8'),newline=''),delimiter=delimiter,strict=True))
            stream=io.StringIO(newline='')
            csv.writer(stream,delimiter=delimiter,lineterminator=ending,quoting=csv.QUOTE_ALL).writerows(rows)
            return observed==rows and data==stream.getvalue().encode()
        except (csv.Error,UnicodeError): return False
    assert inspect(raw),name
    mutations=[raw.replace(b'"',b'',1), raw[:-1], raw+b'"extra"'+ending.encode(), raw.replace(b'\n',b'\r\n',1), raw.replace(b'"',b'"X',1),raw.replace(delimiter.encode(),b'|',1)]
    for index,data in enumerate(mutations): assert not inspect(data),(name,index)
    results.append({'file':name,'rows':len(rows),'cells':sum(map(len,rows)),'sha256':hashlib.sha256(raw).hexdigest(),'mutationsRejected':len(mutations)})
(out/'independent-export.json').write_text(json.dumps({'python':sys.version,'codec':'stdlib csv reader + independent QUOTE_ALL writer','results':results},indent=2)+'\n')
print('Independent generated CSV/TSV oracle: 4 artifacts, 24 mutations rejected')
