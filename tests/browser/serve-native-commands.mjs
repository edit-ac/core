import {createServer} from 'node:http';
import {readFile,mkdir,appendFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,sep,isAbsolute,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const output=process.env.EDITAC_NATIVE_COMMAND_OUTPUT;
if(!output||!isAbsolute(output))throw Error('Set an absolute EDITAC_NATIVE_COMMAND_OUTPUT directory');
await mkdir(output,{recursive:true});
const mounts={fixture:resolve('fixtures/browser-command-surfaces'),core:resolve('packages/core/dist'),web:resolve('packages/web/dist'),markdown:resolve('packages/markdown/dist')};
async function inputs(){
 const values={};
 async function visit(directory){
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const file=resolve(directory,entry.name);
   if(entry.isDirectory())await visit(file);
   else {const bytes=await readFile(file);values[relative(process.cwd(),file)]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}
  }
 }
 for(const directory of Object.values(mounts))await visit(directory);
 return values;
}
const sourceInputs=await inputs();
const server=createServer(async(request,response)=>{
 try{
  const pathname=new URL(request.url,'http://localhost').pathname;
  if(request.method==='POST'&&pathname==='/native-evidence'){
   let body='';for await(const chunk of request){body+=chunk;if(body.length>2000000)throw Error('Receipt too large');}
   const value=JSON.parse(body);await appendFile(resolve(output,'observations.jsonl'),JSON.stringify(value)+'\n');response.writeHead(200,{'Content-Type':'application/json'}).end('{"recorded":true}');return;
  }
  const [,mount,...parts]=(pathname==='/'?'/fixture/native.html':decodeURIComponent(pathname)).split('/');
  const directory=mounts[mount];if(!directory){response.writeHead(404).end();return;}
  const file=resolve(directory,...parts);if(!file.startsWith(directory+sep)){response.writeHead(403).end();return;}
  const body=await readFile(file);response.writeHead(200,{'Content-Type':file.endsWith('.wasm')?'application/wasm':file.endsWith('.html')?'text/html':'text/javascript','Cache-Control':'no-store'}).end(body);
 }catch(error){response.writeHead(500).end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const receipt={pid:process.pid,port:server.address().port,workspace:process.cwd(),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),purpose:'Actual macOS command and spelling observations',log:output,sourceInputs};
await writeFile(resolve(output,'server.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({pid:receipt.pid,port:receipt.port,revision:receipt.revision,log:output}));
let closing=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{
 if(closing)return;closing=true;
 server.closeAllConnections();
 await new Promise(resolve=>server.close(resolve));
 await writeFile(resolve(output,'teardown.json'),JSON.stringify({serverClosed:true,sourcesUnchanged:JSON.stringify(sourceInputs)===JSON.stringify(await inputs())},null,2));
 process.exit(0);
});
