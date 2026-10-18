import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
test('original CNV-1.18 complete direction and target matrix',()=>{
 const manifest=JSON.parse(readFileSync('packages/formats/capabilities.json'));
 const required=['docx-import','docx-export','pdf-export','odt-import','odt-export','rtf-import','rtf-export','epub-import','epub-export','csv-import','csv-export','tsv-import','tsv-export'];
 const actual=new Set(manifest.directions.filter(d=>d.complete!==false).map(d=>`${d.format}-${d.direction}`));
 const missing=required.filter(d=>!actual.has(d));
 const report={schemaVersion:1,gate:'CNV-1.18/I1/V1',parentAcceptanceComplete:missing.length===0,required,implementedPublicDirections:[...actual],missingPublicDirections:missing,
 partialPublicDirections:manifest.directions.filter(d=>d.complete===false),remaining:['Remaining packed container/PDF direction fixtures, complete notices/assets and compiled-target consumer proof','Native optional consumer target matrix and complete conversion cost boundaries','Roadmaps31–36 own final host/native wiring and qualification37 owns final reader/manual/release gaps; these are handoff gaps, not prerequisites to local adapter delivery']};
 writeFileSync(resolve(output,'coverage-receipt.json'),JSON.stringify(report,null,2)+'\n');
 assert.deepEqual(missing,[],`Original1.18 remains open; missing public consumers: ${missing.join(', ')}`);
});
