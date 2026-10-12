// Disposable ENG-1.20 policy: a staged whole batch over the exact v4 transport.
import * as Y from 'yjs';
import {profile,seed,roots,bytes,fork,project,place,admit,applyBounded,tuple} from './mapping.mjs';
const fail=e=>{throw Error(e);};
const maps=d=>profile.roots.map(k=>roots(d)[k]);
const known=v=>['paragraph','heading','code','separator'].includes(v?.[0]);
function target(d,key){const o=project(d).owners.find(o=>o.id===key&&!o.deleted);if(!o||o.kind!=='block'||!o.spans.length||!known(o.attrs))fail('unsupported-target');return o;}
function register(d,key,tuple){if(!/^n:([1-9][0-9]*):([1-9][0-9]*)$/.test(key)||key.split(':').slice(1).some(n=>Number(n)>4294967295))fail('invalid-id');const m=maps(d);if(m[0].has(key))fail('reused-id');d.transact(()=>{m[0].set(key,'block');m[1].set(key,new Y.XmlText());m[2].set(key,['@root',4294967295]);m[4].set(key,tuple);m[6].set(key,true);},'local:policy-stage');}
const boundary=(s,n)=>Number.isInteger(n)&&n>=0&&n<=s.length&&!(n>0&&n<s.length&&/[\uD800-\uDBFF]/.test(s[n-1])&&/[\uDC00-\uDFFF]/.test(s[n]));
function execute(d,c){const m=maps(d);if(c.kind==='separator'){register(d,c.id,['separator']);place(d,c.place,c.id,c.parent,c.before??null);return c.id;}const o=target(d,c.owner);
 if(c.kind==='block'){tuple(c.tuple);if(!known(c.tuple))fail('unsupported-target');if(c.tuple[0]==='separator'&&o.spans.some(s=>s.end!==s.start))fail('nonempty-separator');m[4].set(c.owner,c.tuple);}
 else if(c.kind==='delete')m[3].set(c.owner,true);
 else {if(o.attrs[0]==='separator'||(c.kind==='mark'&&o.attrs[0]==='code'))fail('unsupported-target');const s=o.spans[c.span??0];if(!s)fail('invalid-cut');const x=m[1].get(s.source),plain=x.toDelta().map(r=>r.insert).join(''),end=c.offset+(c.kind==='mark'?c.len:0);if(c.offset<s.start||end>s.end||!boundary(plain,c.offset)||!boundary(plain,end))fail('invalid-cut');if(c.kind==='insert'){if(Buffer.byteLength(c.value)>1048576)fail('resource-limit');if(o.attrs[0]==='code')x.insert(c.offset,c.value,{});else x.insert(c.offset,c.value);}else if(c.kind==='mark')x.format(c.offset,c.len,{italic:true});else fail('unsupported-command');}
 return c.owner;
}
export function prepare(d,commands,neighbor){if(!commands.length)fail('empty-batch');const baseline=bytes(d),stage=fork(d,4000000001);stage.clientID=d.clientID;try{let last;for(const c of commands){last=execute(stage,c);project(stage);}const v=project(stage);if(!v.owners.some(o=>!o.deleted&&o.kind==='block'&&o.spans.length&&['paragraph','heading','code'].includes(o.attrs[0]))){if(!neighbor)fail('missing-editable-neighbor');const at=v.owners.findIndex(o=>o.id===last);if(at<0)fail('unsupported-target');const parent=v.owners[at].parent,before=v.owners.slice(at+1).find(o=>!o.deleted&&o.parent===parent)?.id??null;register(stage,neighbor.id,['paragraph']);place(stage,neighbor.place,neighbor.id,parent,before);}project(stage);const update=bytes(stage),check=fork(d,4000000000);try{admit(check,seed.envelope,update);}finally{check.destroy();}return {baseline,update};}finally{stage.destroy();}}
export function commit(d,p){if(!Buffer.from(bytes(d)).equals(Buffer.from(p.baseline)))fail('stale-preparation');d.transact(t=>{applyBounded(d,p.update,'local:policy');t.local=true;},'local:policy');}
export function batch(d,commands,neighbor){commit(d,prepare(d,commands,neighbor));}
export function renderedRuns(d,key){const o=target(d,key),m=maps(d);return o.spans.flatMap(s=>{let pos=0;return m[1].get(s.source).toDelta().flatMap(r=>{const a=Math.max(0,s.start-pos),b=Math.min(r.insert.length,s.end-pos);pos+=r.insert.length;return b>a?[{insert:r.insert.slice(a,b),attributes:o.attrs[0]==='code'?{}:r.attributes??{}}]:[];});});}
