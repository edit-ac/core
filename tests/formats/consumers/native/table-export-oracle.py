"""Independent stdlib CSV parser and exact expected cells/report oracle (Python3.9)."""
import csv, io
CELLS=[['name','formula','empty'],['🙂 é','=1+1',''],['a\nb','+SUM(A1)','he said "yes"'],['tab\there','-42','@cmd']]
def inspect(payload,request):
    data=bytes(payload['artifact']);text=data.decode('utf-8');assert not text.startswith('\ufeff')
    safe='spreadsheet-safe' in request['profile'];delimiter='\t' if 'tsv' in request['profile'] else ','
    expected=[["'"+c if safe and c and c[0] in '=+-@\t\r\n' else c for c in row] for row in CELLS]
    rows=list(csv.reader(io.StringIO(text,newline=''),delimiter=delimiter,strict=True));assert rows==expected,(rows,expected)
    stream=io.StringIO(newline='');csv.writer(stream,delimiter=delimiter,quoting=csv.QUOTE_ALL,lineterminator='\r\n' if request['newline']=='crlf' else '\n').writerows(expected)
    assert data==stream.getvalue().encode()
    report=payload['report'];assert (report['rows'],report['columns'],report['cells'])==(4,3,12)
    assert report['transformedCells']==(4 if safe else 0)
    ds=report['diagnostics'];codes={d['code'] for d in ds}
    assert {'TEXT_ONLY_FORMAT','OUTSIDE_SELECTED_TABLE','CELL_MARKS_LOST'}<=codes,codes
    assert sum(d['code']=='SPREADSHEET_SAFE_PREFIX' for d in ds)==(4 if safe else 0)
    assert {d['location'] for d in ds if d['code']=='CELL_MARKS_LOST'}=={request['selectedTable']+'/row'+str(i)+'/cell'+str(j) for i in range(4) for j in range(3)}
    assert report['nodes']==29 and report['utf16Units']==sum(len(c.encode('utf-16-le'))//2 for row in CELLS for c in row)
    assert codes=={'TEXT_ONLY_FORMAT','OUTSIDE_SELECTED_TABLE','CELL_MARKS_LOST','IMPLICIT_HEADER_LOST_ROW_RETAINED'}|({'SPREADSHEET_SAFE_PREFIX'} if safe else set())
    assert len(ds)==16+(4 if safe else 0) and sum(d['code']=='OUTSIDE_SELECTED_TABLE' for d in ds)==2
    assert all(d['lossy'] is (d['code'] in ('CELL_MARKS_LOST','IMPLICIT_HEADER_LOST_ROW_RETAINED')) for d in ds)
    assert all(d['location'] and type(d['lossy']) is bool for d in ds)
    assert payload['liveUnchanged'] and payload['reopen'] and payload['activeJobs']==payload['assets']==payload['networkCalls']==0
    return True
