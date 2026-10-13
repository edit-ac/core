// Disposable ENG-1.22 witnessed mapper; production integration is separate.
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import seed from './seed.json' with {type:'json'};
import profile from './profile.json' with {type:'json'};
export {seed,profile};
export const roots=d=>Object.fromEntries(profile.roots.map(k=>[k,d.getMap(k)]));
export const bytes=d=>Y.encodeStateAsUpdate(d);
export function replica(client){const d=new Y.Doc();d.clientID=client;roots(d);return d;}
export function construct() {
 const d=replica(seed.writer),m=profile.roots.map(k=>roots(d)[k]);
 d.transact(()=>{
  for(const n of seed.nodes){m[0].set(n.id,'block');const x=new Y.XmlText();m[1].set(n.id,x);x.insert(0,n.text);if(n.text)x.format(0,n.text.length,{bold:true,'ext:future':{retained:true}});m[2].set(n.id,[n.parent,n.order]);m[4].set(n.id,n.tuple);m[6].set(n.id,true);if('check' in n)m[8].set(n.id,['check',n.check]);}
  for(const c of seed.containers){m[0].set(c.id,c.kind);m[2].set(c.id,[c.parent,c.order]);m[7].set(c.id,c.tuple);}
 },'initialize');return d;
}
export function fork(d,client){const r=replica(client);Y.applyUpdate(r,bytes(d),'restore');return r;}
const fail=e=>{throw Error(e);};
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function id(s,prefix){const a=typeof s==='string'?s.split(':'):[];if(s?.length>96||a.length!==3||a[0]!==prefix)fail('invalid-id');const n=a.slice(1).map(v=>{if(!/^[1-9][0-9]*$/.test(v)||Number(v)>4294967295)fail('invalid-id');return Number(v);});return n;}
const ownerId=s=>id(s,s?.startsWith('n:')?'n':'o');
const integer=n=>{if(!Number.isInteger(n)||n<0||n>4294967295)fail('invalid-shape');return n;};
const json=(v,depth=0)=>depth<=32&&(v===null||typeof v==='boolean'||typeof v==='string'||(typeof v==='number'&&Number.isFinite(v))||(Array.isArray(v)&&v.every(x=>json(x,depth+1)))||(v&&Object.getPrototypeOf(v)===Object.prototype&&Object.values(v).every(x=>json(x,depth+1))));
export function tuple(v){if(!Array.isArray(v)||typeof v[0]!=='string'||!json(v))fail('invalid-tuple');if(v[0]==='paragraph'&&v.length!==1)fail('invalid-tuple');if(v[0]==='code'&&(v.length!==2||typeof v[1]!=='string'||v[1].length>64||!/^[A-Za-z0-9+._-]*$/.test(v[1])))fail('invalid-tuple');if(v[0]==='separator'&&v.length!==1)fail('invalid-tuple');if(v[0]==='heading'&&(v.length!==2||!Number.isInteger(v[1])||v[1]<1||v[1]>6))fail('invalid-tuple');if(['unordered','ordered','quote','checklist','check','enabled'].includes(v[0]))fail('invalid-tuple');return v;}
const compare=(a,b)=>a[0]-b[0]||a[1]-b[1];
const plain=x=>x.toDelta().map(v=>{if(typeof v.insert!=='string')fail('invalid-text');return v.insert;}).join('');
const boundary=(s,n)=>n>=0&&n<=s.length&&!(n>0&&n<s.length&&s.charCodeAt(n-1)>=0xd800&&s.charCodeAt(n-1)<=0xdbff&&s.charCodeAt(n)>=0xdc00&&s.charCodeAt(n)<=0xdfff);
function runs(x,start,end){let pos=0;return x.toDelta().flatMap(v=>{if(typeof v.insert!=='string')fail('invalid-text');const a=Math.max(0,start-pos),b=Math.min(v.insert.length,end-pos);pos+=v.insert.length;return b>a?[{insert:v.insert.slice(a,b),attributes:v.attributes??{}}]:[];});}
function canonical(key){const p=key?.split(':')[0];if(!['c','n','o'].includes(p))fail('invalid-id');return [p,...id(key,p)];}
const cmpId=(a,b)=>a[0].localeCompare(b[0])||a[1]-b[1]||a[2]-b[2];
function boolTuple(v,k){if(!Array.isArray(v)||v.length!==2||v[0]!==k||typeof v[1]!=='boolean')fail('invalid-tuple');}
function containerTuple(v){if(['paragraph','heading','code','separator','check','enabled'].includes(v?.[0]))fail('invalid-tuple');if(!Array.isArray(v)||typeof v[0]!=='string'||!json(v))fail('invalid-tuple');if(['quote','checklist','unordered'].includes(v[0])&&v.length!==1)fail('invalid-tuple');if(v[0]==='ordered'&&(v.length!==2||!Number.isInteger(v[1])||v[1]<1||v[1]>2147483647))fail('invalid-tuple');}
const enabled=(controls,k)=>controls.get(k)?.[1]!==false;
const container=o=>o.id.startsWith('c:')&&['list','quote'].includes(o.kind);
function descendant(owners,start,target){let cursor=start;for(let i=0;i<=owners.length;i++){if(cursor===target)return true;if(cursor==='@root')return false;const o=owners.find(o=>o.id===cursor);if(!o)return false;cursor=o.parent;}return true;}
function normalize(owners,repair,budget){
 const valid=new Set(owners.filter(o=>!o.deleted&&container(o)).map(o=>o.id));
 for(const o of owners)if(o.parent!=='@root'&&!valid.has(o.parent))o.parent='@root';
 const parents=new Map(owners.map(o=>[o.id,o.parent]));
 for(const start of parents.keys()){
  const path=[];let cursor=start;
  while(cursor!=='@root'){if(++budget.visits>16777216)fail('resource-limit');const at=path.indexOf(cursor);if(at>=0){if(!repair)fail('cycle');const detached=path.slice(at).sort((a,b)=>cmpId(canonical(a),canonical(b)))[0];parents.set(detached,'@root');owners.find(o=>o.id===detached).parent='@root';break;}path.push(cursor);if(path.length>4096)fail('resource-limit');cursor=parents.get(cursor);}
 }
 for(const start of parents.keys()){let cursor=parents.get(start),depth=0;while(cursor!=='@root'){if(++budget.visits>16777216)fail('resource-limit');if(++depth>128)fail('resource-limit');cursor=parents.get(cursor);}}
 const children=new Map();for(const o of owners){if(!children.has(o.parent))children.set(o.parent,[]);children.get(o.parent).push(o);}const stack=(children.get('@root')??[]).slice().reverse();children.delete('@root');owners.length=0;
 while(stack.length){const o=stack.pop();owners.push(o);stack.push(...(children.get(o.id)??[]).slice().reverse());children.delete(o.id);}if(children.size)fail('cycle');
}
function effective(o,attrs,inherited){let key=o.id;for(let i=0;i<=128;i++){if(attrs.has(key))return attrs.get(key);if(!inherited.has(key))return ['paragraph'];key=inherited.get(key);}fail('resource-limit');}
export function witnessTuple(v){tuple(v);if(!['paragraph','heading','code'].includes(v[0]))fail('invalid-witness');return v;}
export function witnessPair(a,b){witnessTuple(a);witnessTuple(b);if((a[0]==='code'||b[0]==='code')&&!eq(a,b))fail('incompatible-witness');}
function operation(key,a){
 id(key,'o');if(!Array.isArray(a))fail('invalid-operation');let o={id:key,left:a[1],lv:a[2]};
 if(a[0]==='split'&&a.length===7&&a[5] instanceof Uint8Array){witnessTuple(a[6]);o.witnesses=[a[6]];if(a[5].length>256)fail('resource-limit');integer(a[3]);id(a[4],'n');Y.decodeRelativePosition(a[5]);o.cut={index:a[3],source:a[4],bytes:a[5]};ownerId(o.left);}
 else if(a[0]==='join'&&a.length===7){witnessPair(a[5],a[6]);o.witnesses=[a[5],a[6]];o.right=a[3];o.rv=a[4];ownerId(o.left);ownerId(o.right);if(o.left===o.right)fail('invalid-operation');}
 else if(a[0]==='place'&&a.length===7){canonical(o.left);canonical(a[3]==='@root'?o.left:a[3]);if(a[3]==='@root'&&a[4]!=='base')fail('invalid-operation');if(a[5]!==null){canonical(a[5]);if(typeof a[6]!=='string')fail('invalid-operation');}else if(a[6]!==null)fail('invalid-operation');o.place={parent:a[3],pv:a[4],before:a[5],bv:a[6]};}
 else fail('invalid-operation');
 o.deps=[o.lv,...(o.right?[o.rv]:[]),...(o.place?[o.place.pv,...(o.place.before?[o.place.bv]:[])]:[])].filter(v=>v!=='base');
 for(const dep of o.deps){id(dep,'o');if(dep===key)fail('cycle');}return o;
}
export function project(d){
 const m=roots(d),[kinds,texts,placements,tombstones,attrs,records,origins,containerAttrs,checks,controls]=profile.roots.map(k=>m[k]);
 if(d.store.pendingStructs||d.store.pendingDs)fail('missing-binary-dependency');for(const [k,v]of d.share)if(!profile.roots.includes(k)||(!(v instanceof Y.Map)||v._start!==null))fail('invalid-root');
 if(kinds.size>4096||records.size>4096||controls.size>8192)fail('resource-limit');
 const keys=map=>[...map.keys()].sort(),originals=keys(kinds).filter(k=>k.startsWith('n:'));
 if(!eq(keys(kinds),keys(placements))||!eq(originals,keys(origins))||texts.size!==originals.length)fail('invalid-source');
 for(const [k,v]of controls){canonical(k);boolTuple(v,'enabled');}
 let total=0;const sources={},sourceTexts=new Map();let owners=[];
 for(const [key,kind]of kinds){
  const keyOrder=canonical(key),source=key.startsWith('n:');
  if(typeof kind!=='string'||key.startsWith('o:')||(source&&['list','quote'].includes(kind))||(!source&&kind==='block'))fail('invalid-source');
  const p=placements.get(key);if(!Array.isArray(p)||p.length!==2||typeof p[0]!=='string')fail('invalid-placement');if(p[0]!=='@root')canonical(p[0]);integer(p[1]);
  const spans=[];
  if(source){if(origins.get(key)!==true)fail('invalid-source');const x=texts.get(key);if(!(x instanceof Y.XmlText))fail('invalid-source');const s=plain(x);total+=Buffer.byteLength(s);if(total>1048576||s.length>262144)fail('resource-limit');sources[key]={identity:`${x._item.id.client}:${x._item.id.clock}`,runs:runs(x,0,s.length)};sourceTexts.set(key,{x,s});spans.push({source:key,start:0,end:s.length});}
  else {const a=containerAttrs.get(key);containerTuple(a);if(kind==='list'&&a[0]==='quote'||kind==='quote'&&['ordered','unordered','checklist'].includes(a[0]))fail('invalid-container');}
  owners.push({id:key,version:'base',parent:p[0],kind,spans,order:p[1],keyOrder,deleted:tombstones.has(key)||!enabled(controls,key)});
 }
 for(const key of containerAttrs.keys())if(!kinds.has(key)||!key.startsWith('c:'))fail('invalid-container');
 owners.sort((a,b)=>a.order-b.order||cmpId(a.keyOrder,b.keyOrder));owners=owners.map(({order,keyOrder,...o})=>o);const budget={visits:0};normalize(owners,true,budget);
 const ops=new Map([...records].map(([k,v])=>[k,operation(k,v)]));
 for(const [k,v]of tombstones){canonical(k);if(v!==true||(!kinds.has(k)&&!ops.get(k)?.cut))fail('invalid-tombstone');}
 for(const [k,v]of attrs){ownerId(k);if(!origins.has(k)&&!ops.get(k)?.cut)fail('invalid-target');tuple(v);}
 for(const [k,v]of checks){ownerId(k);if(!origins.has(k)&&!ops.get(k)?.cut)fail('invalid-target');boolTuple(v,'check');}
 for(const op of ops.values())if(op.cut){const rel=Y.decodeRelativePosition(op.cut.bytes);if(rel.assoc!==-1)fail('invalid-cut');const src=sourceTexts.get(op.cut.source),pos=Y.createAbsolutePositionFromRelativePosition(rel,d);if(src&&pos&&(pos.type!==src.x||!boundary(src.s,pos.index)))fail('invalid-cut');}
 const depths=new Map(),heights=new Map();for(let round=0;round<=ops.size;round++){let changed=false;for(const [key,op]of ops){if(depths.has(key))continue;budget.visits+=op.deps.length;if(budget.visits>16777216)fail('resource-limit');const known=op.deps.filter(k=>ops.has(k));if(known.every(k=>depths.has(k))){const n=Math.max(0,...known.map(k=>heights.get(k)))+1;if(n>128)fail('resource-limit');heights.set(key,n);depths.set(key,op.deps.some(k=>!ops.has(k)||depths.get(k)===null)?null:n);changed=true;}}if(!changed)break;}if(depths.size!==ops.size)fail('cycle');
 const ranked=[...ops.values()].filter(o=>depths.get(o.id)!==null).sort((a,b)=>depths.get(a.id)-depths.get(b.id)||compare(id(a.id,'o'),id(b.id,'o')));
 const outcomes=Object.fromEntries([...depths].filter(([,n])=>n===null).map(([k])=>[k,'dormant'])),inherited=new Map();
 for(const op of ranked){
  if(!enabled(controls,op.id)){outcomes[op.id]='disabled';continue;}let status='losing';
  if(op.deps.every(k=>outcomes[k]==='applied')){const i=owners.findIndex(o=>o.id===op.left&&o.version===op.lv&&!o.deleted);if(i>=0){
   if(op.place){const {parent,pv,before,bv}=op.place,parentOk=parent==='@root'||owners.some(o=>o.id===parent&&o.version===pv&&!o.deleted&&supportedContainer(o,containerAttrs)),beforeOk=before===null||owners.some(o=>o.id===before&&o.version===bv&&!o.deleted&&o.parent===parent&&o.id!==op.left);
    if(parentOk&&beforeOk&&(supportedContainer(owners[i],containerAttrs)||(owners[i].kind==='block'&&owners[i].spans.length))&&!descendant(owners,parent,op.left)){const [moved]=owners.splice(i,1);moved.parent=parent;moved.version=op.id;let at=before===null?owners.length:owners.findIndex(o=>o.id===before);owners.splice(at,0,moved);normalize(owners,false,budget);status='applied';}
   }else if(op.right){const j=owners.findIndex((o,k)=>k>i&&!o.deleted&&o.parent===owners[i].parent&&o.spans.length);
    if(j>=0&&owners[j].id===op.right&&owners[j].version===op.rv&&owners[i].kind==='block'&&owners[j].kind==='block'&&owners[i].spans.length){owners[i].spans.push(...owners[j].spans);owners.splice(j,1);owners[i].version=op.id;status='applied';}
   }else if(owners[i].kind==='block'&&owners[i].spans.length){
    const {index,source,bytes}=op.cut,src=sourceTexts.get(source);if(!src){outcomes[op.id]='dormant';continue;}
    const pos=Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(bytes),d);
    if(pos){if(pos.type!==src.x||!boundary(src.s,pos.index))fail('invalid-cut');const span=owners[i].spans[index];if(!span||span.source!==source||pos.index<span.start||pos.index>span.end)fail('invalid-cut');const left=[...owners[i].spans.slice(0,index),{source,start:span.start,end:pos.index}],right=[{source,start:pos.index,end:span.end},...owners[i].spans.slice(index+1)];owners[i].spans=left;owners[i].version=op.id;owners.splice(i+1,0,{id:op.id,version:op.id,parent:owners[i].parent,kind:'block',spans:right,deleted:tombstones.has(op.id)});inherited.set(op.id,op.left);status='applied';}else status='dormant';
   }
  }}outcomes[op.id]=status;
 }
 for(const o of owners){o.deleted=tombstones.has(o.id)||(o.id.startsWith('n:')||o.id.startsWith('c:'))&&!enabled(controls,o.id);o.attrs=o.id.startsWith('c:')?containerAttrs.get(o.id):effective(o,attrs,inherited);}normalize(owners,false,budget);
 if(owners.reduce((n,o)=>n+o.spans.length,0)>8192)fail('resource-limit');for(const [source,{s}]of sourceTexts){const spans=owners.flatMap(o=>o.spans).filter(v=>v.source===source).sort((a,b)=>a.start-b.start||a.end-b.end);let end=0;for(const span of spans){if(span.start!==end||span.end<span.start)fail('coverage');end=span.end;}if(end!==s.length)fail('coverage');}
 return {owners,outcomes,retained:Object.fromEntries(attrs),sources};
}
export function snapshot(d){
 const v=project(d),m=profile.roots.map(k=>roots(d)[k]);
 const node=o=>{const p=v.owners.find(p=>p.id===o.parent);return {id:o.id,version:o.version,parent:o.parent,kind:o.kind,spans:o.spans.map(s=>[s.source,s.start,s.end]),runs:o.spans.flatMap(s=>runs(m[1].get(s.source),s.start,s.end)),tuple:o.attrs,presentation:['paragraph','heading','code','separator'].includes(o.attrs[0])?o.attrs:['paragraph'],check:p?.attrs[0]==='checklist'&&numbered(o)?m[8].get(o.id)?.[1]===true:null,number:p?.attrs[0]==='ordered'&&numbered(o)&&!o.deleted?p.attrs[1]+v.owners.slice(0,v.owners.indexOf(o)).filter(p=>p.parent===o.parent&&!p.deleted&&numbered(p)).length:null};};
 return {intentions:Object.fromEntries([...m[5]].map(([k,v])=>[k,v.map(x=>x instanceof Uint8Array?[...x]:x)])),containers:Object.fromEntries(m[7]),checks:Object.fromEntries(m[8]),controls:Object.fromEntries(m[9]),visible:v.owners.filter(o=>!o.deleted).map(node),deleted:v.owners.filter(o=>o.deleted).map(node),outcomes:v.outcomes,retained:v.retained,sources:v.sources};
}
function commitRecord(d,op,record){const stage=fork(d,4000000001);try{stage.transact(()=>roots(stage)[profile.roots[5]].set(op,record),'local:fixture');if(project(stage).outcomes[op]!=='applied')fail('ineligible-operation');d.transact(()=>roots(d)[profile.roots[5]].set(op,record),'local:fixture');}finally{stage.destroy();}}
export function split(d,op,left,index,offset){id(op,'o');const v=project(d);if(Object.hasOwn(v.outcomes,op))fail('reused-id');const owner=v.owners.find(o=>o.id===left&&!o.deleted);if(!owner)fail('deleted-target');if(owner.attrs[0]==='separator')fail('unsupported-target');witnessTuple(owner.attrs);const span=owner.spans[index];if(!span)fail('invalid-cut');const x=roots(d)[profile.roots[1]].get(span.source);if(offset<span.start||offset>span.end||!boundary(plain(x),offset))fail('invalid-cut');const cut=Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(x,offset,-1));commitRecord(d,op,['split',left,owner.version,index,span.source,cut,[...owner.attrs]]);}
export function join(d,op,left,right){id(op,'o');const v=project(d);if(Object.hasOwn(v.outcomes,op))fail('reused-id');const i=v.owners.findIndex(o=>o.id===left&&!o.deleted),a=v.owners[i];if(i<0)fail('deleted-target');if(a.attrs[0]==='separator'||v.owners.some(o=>o.id===right&&!o.deleted&&o.attrs[0]==='separator'))fail('unsupported-target');const b=v.owners.slice(i+1).find(o=>!o.deleted&&o.parent===a.parent&&o.spans.length);if(!b||b.id!==right)fail('nonadjacent-target');if(a.attrs[0]==='separator'||b.attrs[0]==='separator')fail('unsupported-target');witnessPair(a.attrs,b.attrs);commitRecord(d,op,['join',left,a.version,right,b.version,[...a.attrs],[...b.attrs]]);}
export function place(d,op,target,parent,before=null){id(op,'o');const v=project(d);if(Object.hasOwn(v.outcomes,op))fail('reused-id');const a=v.owners.find(o=>o.id===target&&!o.deleted);if(!a)fail('deleted-target');if(!(container(a)&&['ordered','unordered','checklist','quote'].includes(a.attrs[0])||a.kind==='block'&&a.spans.length&&['paragraph','heading','code','separator'].includes(a.attrs[0])))fail('unsupported-target');const p=parent==='@root'?{version:'base'}:v.owners.find(o=>o.id===parent&&!o.deleted&&container(o)&&['ordered','unordered','checklist','quote'].includes(o.attrs[0]));if(!p)fail('illegal-parent');if(descendant(v.owners,parent,target))fail('cycle');const b=before===null?null:v.owners.find(o=>o.id===before&&!o.deleted&&o.parent===parent&&o.id!==target);if(before!==null&&!b)fail('invalid-before');commitRecord(d,op,['place',target,a.version,parent,p.version,before,b?.version??null]);}
export function resolve(d,source,encoded){const v=project(d),rel=Y.decodeRelativePosition(encoded),pos=Y.createAbsolutePositionFromRelativePosition(rel,d);if(!pos||pos.type!==roots(d)[profile.roots[1]].get(source))fail('unresolvable');const interior=[],edge=[];for(const o of v.owners){let n=0;for(const s of o.spans){if(s.source===source){const value=[o.id,n+pos.index-s.start,o.deleted];if(pos.index>s.start&&pos.index<s.end)interior.push(value);else if((rel.assoc<0&&pos.index===s.end)||(rel.assoc>=0&&pos.index===s.start))edge.push(value);}n+=s.end-s.start;}}return interior[0]??(rel.assoc<0?edge[0]:edge.at(-1))??fail('unresolvable');}
export function admit(d,offered,b){const e=seed.envelope;if(!offered||Object.keys(offered).length!==Object.keys(e).length||Object.keys(e).some(k=>!Object.hasOwn(offered,k)))fail('invalid-metadata');for(const k of Object.keys(e)){if(e[k]!==offered[k])fail(k==='epoch'?'wrong-epoch':k==='documentId'?'wrong-document':'unsupported-profile');}if(b.length>16777216)fail('resource-limit');const stage=fork(d,4000000000);try{applyBounded(stage,b,'remote');project(stage);for(const index of [0,2,3,5,6]){const old=roots(d)[profile.roots[index]],next=roots(stage)[profile.roots[index]];for(const [k,v]of old)if(!eq(v,next.get(k)))fail('immutable-replacement');}const old=project(d).sources,next=project(stage).sources;for(const k of Object.keys(old))if(old[k].identity!==next[k]?.identity)fail('immutable-replacement');applyBounded(d,b,'remote');}finally{stage.destroy();}}
export class BoundedDecoder extends Y.UpdateDecoderV1 {
 constructor(d){super(d);this.values=0;this.structs=0;}
 readInfo(){if(++this.structs>262144)fail('resource-limit');return super.readInfo();}
 readLen(){const n=super.readLen();if(n>1048576)fail('resource-limit');return n;}
 readAny(){return this.any(0);}
 readJSON(){const v=super.readJSON();if(!json(v))fail('resource-limit');return v;}
 any(depth){if(depth>32||++this.values>262144)fail('resource-limit');const d=this.restDecoder;switch(decoding.readUint8(d)){case 127:return undefined;case 126:return null;case 125:return decoding.readVarInt(d);case 124:return decoding.readFloat32(d);case 123:return decoding.readFloat64(d);case 122:return decoding.readBigInt64(d);case 121:return false;case 120:return true;case 119:return decoding.readVarString(d);case 118:{const n=decoding.readVarUint(d);if(n>8192)fail('resource-limit');const v=Object.create(null);for(let i=0;i<n;i++)v[decoding.readVarString(d)]=this.any(depth+1);return {...v};}case 117:{const n=decoding.readVarUint(d);if(n>8192)fail('resource-limit');const v=[];for(let i=0;i<n;i++)v.push(this.any(depth+1));return v;}case 116:return decoding.readVarUint8Array(d);default:fail('invalid-bytes');}}
}
export function applyBounded(d,b,origin='remote'){if(b.length>16777216)fail('resource-limit');Y.applyUpdateV2(d,b,origin,BoundedDecoder);}
export function restoreCheckpoint(offered,initialized,checkpoint,client){if(initialized!==true)fail('missing-initializer');if(!Number.isInteger(client)||client<1||client>4294967295)fail('invalid-writer');const d=replica(client);try{admit(d,offered,checkpoint);return d;}catch(e){d.destroy();throw e;}}

const supportedContainer=(o,attrs)=>container(o)&&(o.kind==='list'?['ordered','unordered','checklist'].includes(attrs.get(o.id)?.[0]):attrs.get(o.id)?.[0]==='quote');
const supportedLeaf=(o,attrs,inherited)=>o.kind==='block'&&o.spans.length&&['paragraph','heading','code','separator'].includes(effective(o,attrs,inherited)[0]);
const numbered=o=>o.kind==='block'&&o.spans.length&&['paragraph','heading','code'].includes(o.attrs[0]);
