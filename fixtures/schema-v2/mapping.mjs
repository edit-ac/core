// Exact development mapping; support is contingent on ENG-1.16's receipt.
import * as Y from 'yjs';
import seed from './seed.json' with { type: 'json' };
import profile from './profile.json' with { type: 'json' };
export { seed, profile };
export function roots(doc) { return Object.fromEntries(Object.keys(profile.roots).map(name => [name, doc.getMap(name)])); }
export function constructSeed(client = seed.clientId) {
 const doc=new Y.Doc();doc.clientID=client;const maps=roots(doc);
 doc.transact(()=>{seed.nodes.forEach((node,order)=>{
  maps['registry-parents'].set(node.id,node.kind);const text=new Y.XmlText();maps['registry-texts'].set(node.id,text);text.insert(0,node.text,node.marks);
  maps['registry-placements'].set(node.id,['@root',order]);maps['registry-block-attributes'].set(node.id,node.attributes.slice());
 });maps['probe-split-join'].set('pair',seed.ownership.slice());},'initialize');return doc;
}
const keys=['profile','schema','protocolVersion','updateEncoding','offsets'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function admit(expected,incoming) {
 const valid=value=>value && typeof value==='object' && !Array.isArray(value)
  && [...keys,'documentId','epoch'].every(key=>Object.hasOwn(value,key))
  && ['profile','schema','offsets','documentId','epoch'].every(key=>typeof value[key]==='string')
  && Number.isInteger(value.protocolVersion) && Number.isInteger(value.updateEncoding)
  && uuid.test(value.documentId) && uuid.test(value.epoch);
 if (![expected,incoming].every(valid)) return 'invalid-metadata';
 if(keys.some(key=>expected[key]!==seed.envelope[key] || incoming[key]!==expected[key]))return 'unsupported-profile';
 if(incoming.documentId!==expected.documentId)return 'wrong-document';if(incoming.epoch!==expected.epoch)return 'wrong-epoch';return 'accepted';
}
export function tuple(value) {
 if(!Array.isArray(value)||typeof value[0]!=='string')throw new Error('invalid-tuple');
 if(value[0]==='paragraph'){if(value.length!==1)throw new Error('invalid-tuple');return value;}
 if(value[0]==='heading'){if(value.length!==2||!Number.isInteger(value[1])||value[1]<1||value[1]>6)throw new Error('invalid-tuple');return value;}
 const json=(v,depth=0)=>depth<=32&&(v===null||typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v))||(Array.isArray(v)&&v.every(x=>json(x,depth+1)))||(v && Object.getPrototypeOf(v)===Object.prototype&&Object.values(v).every(x=>json(x,depth+1))));
 if(!json(value))throw new Error('invalid-tuple');return value;
}
export function ownerTuple(maps,id) {const value=maps['registry-block-attributes'].get(id)??(id==='block-split'?maps['registry-block-attributes'].get('block-1'):undefined)??['paragraph'];return tuple(value);}
