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
void raw;
