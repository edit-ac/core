// Execute the two affected original canonical PDF groups, preserving exact logs
// and dispatcher counts. Other groups are authenticated by the matrix reconciler.
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execute} from './run.mjs';
import {execFileSync} from 'node:child_process';
const output=resolve(process.env.EDITAC_FORMATS_OUTPUT);
const suite=JSON.parse(readFileSync('tests/formats/capabilities.json')).scenarios['consumers-native-pdf-export'];
if(!process.env.EDITAC_PDF_PYTHON) throw Error('Set EDITAC_PDF_PYTHON to the pinned independent generated-PDF validator environment before proof execution.');
const reader=JSON.parse(execFileSync(process.env.EDITAC_PDF_PYTHON,['-c',
 'import importlib.metadata as m,json,sys; print(json.dumps(dict(python=sys.version,packages={n:m.version(n) for n in ["pypdf","PyMuPDF","fonttools","typing-extensions"]})))'],{encoding:'utf8'}));
for(const [name,version] of Object.entries({pypdf:'6.1.1',PyMuPDF:'1.26.5',fonttools:'4.60.1','typing-extensions':'4.16.0'})) {
 if(reader.packages[name]!==version)throw Error('Independent PDF reader version mismatch: '+name);
}
writeFileSync(resolve(output,'reader-environment.json'),JSON.stringify(reader,null,2)+'\n');
const runtimeOnly=process.argv.includes('--runtime-only');
const receipt={schemaVersion:1,scenario:'native-matrix-pdf-current',originalScenario:'consumers-native-pdf-export',checks:[]};
try {
 for(const index of (runtimeOnly?[7]:[1,7])) {
  const command=suite.commands[index];
  try { receipt.checks.push(execute(command,process.cwd(),resolve(output,`${index}-${command.kind}${runtimeOnly?'-repaired':''}.log`))); }
  catch(error) { if(error.receipt)receipt.checks.push(error.receipt); throw error; }
 }
} finally {
 writeFileSync(resolve(output,runtimeOnly?'receipt-runtime.json':'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
 if(!runtimeOnly&&receipt.checks[1]?.exit===0) {
  writeFileSync(resolve(output,'receipt-runtime.json'),JSON.stringify({...receipt,checks:[receipt.checks[1]]},null,2)+'\n');
 }
}
console.log(JSON.stringify(receipt.checks.map(c=>({command:c.args,exit:c.exit,counts:c.counts}))));
