/** Prepared callback transport only. Deliberately permits late emits so production
 * generation/abort checks, rather than a friendly mock, must protect the document. */
export class MockAssistiveTransport {
 sessions=[];
 start(request,signal,emit) {
  const item={request,signal,emit,stopped:0,cancelled:0,disposed:0};this.sessions.push(item);
  const handle={stop:()=>{item.stopped++;},cancel:()=>{item.cancelled++;},dispose:()=>{item.disposed++;}};
  if(this.synchronous) emit({type:'result',result:{version:1,session:request.session,sequence:0,kind:'final',text:this.synchronous}});
  return handle;
 }
 result(text,sequence=0,kind='final',index=this.sessions.length-1,session) {
  const s=this.sessions[index];s.emit({type:'result',result:{version:1,session:session??s.request.session,sequence,kind,text}});
 }
 error(reason,index=this.sessions.length-1) {const s=this.sessions[index];s.emit({type:'error',session:s.request.session,reason});}
 audit(){return this.sessions.map(s=>({aborted:s.signal.aborted,stopped:s.stopped,cancelled:s.cancelled,disposed:s.disposed,generation:s.request.session.generation,requestKeys:Object.keys(s.request)}));}
}
