// Prepared browser failures at the real IndexedDB API boundary; no fake editor/store.
export function installFault({databaseName,operation='append'}){
  const prototype=operation==='open'?IDBFactory.prototype:IDBDatabase.prototype;
  const method=operation==='open'?'open':'transaction',original=prototype[method];
  prototype[method]=function(...args){
    const matches=operation==='open'?args[0]===databaseName:this.name===databaseName&&args[1]==='readwrite'&&[args[0]].flat().includes('updates');
    if(matches)throw new DOMException(`Prepared ${operation} denial for ${databaseName}`,operation==='open'?'SecurityError':'QuotaExceededError');
    return original.apply(this,args);
  };
  return ()=>{prototype[method]=original;};
}
export async function inspectDatabase(name){
  const db=await new Promise((yes,no)=>{const r=indexedDB.open(name);r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error);});
  try{return await new Promise((yes,no)=>{
    const result={},tx=db.transaction([...db.objectStoreNames],'readonly');
    for(const name of db.objectStoreNames){const r=tx.objectStore(name).count();r.onsuccess=()=>{result[name]=r.result;};}
    tx.oncomplete=()=>yes(result);tx.onerror=()=>no(tx.error);
  });}finally{db.close();}
}
export async function damageCheckpoint(name,kind){
  const db=await new Promise((yes,no)=>{const r=indexedDB.open(name);r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error);});
  try{await new Promise((yes,no)=>{
    const tx=db.transaction('checkpoints','readwrite'),store=tx.objectStore('checkpoints');
    if(kind==='missing')store.clear();
    else {
      const r=store.openCursor();r.onsuccess=()=>{const cursor=r.result;if(!cursor)return;
        const value=cursor.value;
        for(const retained of [value.latest,value.previous])if(retained)retained.checkpoint.bytes[0]^=255;
        cursor.update(value);cursor.continue();};
    }
    tx.oncomplete=yes;tx.onerror=()=>no(tx.error);
  });}finally{db.close();}
}
