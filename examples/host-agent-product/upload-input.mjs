// UTF-8 framing only. Source reconciliation and candidate admission belong to the
// public host/Session owners. Text is never interpreted as a URL or instruction.
export function candidateChunks(source) {
  if(typeof source!=='string' || !source.isWellFormed())throw Error('invalid');
  const encode=new TextEncoder(),total=encode.encode(source).length;
  if(total>4096)throw Error('limit');
  const chunks=[];let chunk='',size=0;
  for(const char of source){const bytes=encode.encode(char).length;if(size+bytes>1024){chunks.push(chunk);chunk='';size=0;}chunk+=char;size+=bytes;}
  if(chunk)chunks.push(chunk);
  return {source,total,chunks};
}
export async function checksum(source) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source));
  return 'sha256:'+Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
