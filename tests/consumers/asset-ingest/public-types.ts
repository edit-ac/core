import type { EngineHandle, AssetGrant, AssetWorkResult } from '@edit-ac/core';
import {AssetSession, type AssetHostTransport, type AssetOperationReceipt} from '@edit-ac/web/assets';
declare const e:EngineHandle,host:AssetHostTransport,grant:AssetGrant;
const raw:AssetWorkResult=e.assetWork(null,{type:'inspect'});
const session:Promise<AssetSession>=AssetSession.open(e,indexedDB,'document');
session.then(async s=>{const receipt:AssetOperationReceipt=await s.enqueue('stable-node',{version:1,operationId:'ingest',identity:grant.identity,action:'ingest',byteLimit:32},grant,new Uint8Array([1]));await s.runOne(receipt.operationId,true,host);await s.dispose('suspend');});
// @ts-expect-error operation receipts cannot acknowledge a document update
const documentReceipt:{updateId:string}=null as unknown as AssetOperationReceipt;
// @ts-expect-error explicit source grant is mandatory
session.then(s=>s.enqueue('node',{version:1,operationId:'id',identity:grant.identity,action:'ingest',byteLimit:1}));
session.then(async s=>{
  const request={version:1 as const,operationId:'stage_original',identity:grant.identity,action:'ingest' as const,byteLimit:32};
  const staged:AssetOperationReceipt=await s.stageOriginal('import_job','prepared_original',request,grant,new Uint8Array([0,255]));
  const source:Uint8Array=await s.preparedSource('import_job','prepared_original',grant);
  const fences:readonly string[]=(await s.inspect()).fencedJobs;
  await s.fenceJob('import_job');
  // @ts-expect-error staging requires explicit authority
  await s.stageOriginal('import_job','other',request,new Uint8Array([1]));
  void [staged,source,fences];
});
void raw;
