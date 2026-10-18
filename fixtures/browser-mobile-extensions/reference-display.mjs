import { privateReferenceDisplay } from '/web/modules/references/display.js';
// Hand-authored host. No remote endpoint, credential, provider or real navigation.
export function referenceDisplay() {
 const state=window.mobileReferenceDisplay={authorized:true,revision:1,calls:[],dispatches:[],listeners:new Set(),signals:[]};
 const context=()=>({principal:'prepared-viewer',tenant:'fixture',authority:'team-1',scope:{document:'fixture',session:'mobile',revision:String(state.revision),permission:String(state.revision),authorized:state.authorized},policyRevision:'1',readonly:false,capabilities:{publicMetadata:false,privateLookup:state.authorized,title:state.authorized,icon:false,preview:state.authorized,activate:state.authorized,publishMetadata:false}});
 return privateReferenceDisplay({context,target:targetId=>({targetId,authority:'team-1'}),cached:()=>undefined,
  subscribe(f){state.listeners.add(f);return ()=>state.listeners.delete(f);},
  ports:{privateCatalog(request,signal){state.calls.push(request);state.signals.push(signal);return new Promise(resolve=>{state.complete=resolve;});}},
  activation:{catalog:{catalog:targetId=>({targetId,status:state.authorized?'hosted':'forbidden'})},privateLocator:()=> 'ac://team-1/12345678-1234-4234-8234-123456789abc',dispatch:action=>{state.dispatches.push(action);return 'available';}},
 });
}
