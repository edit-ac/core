// Optional local package composition. The launcher pins metadata to its installed
// package. Merely opening the workspace loads no converter or file permissions.
export async function mountTaskFormats(editor, root) {
  const [{formatControls},pin] = await Promise.all([
    import('@edit-ac/web/formats'), import('/fixture/installed-formats/pin.mjs'),
  ]);
  const controls=editor.enableFormatControls(formatControls({
    async loadProfiles(signal) {
      const response=await fetch('/fixture/installed-formats/capabilities.json',{signal,credentials:'omit'});
      if(!response.ok)throw Error('Installed format metadata unavailable');
      const reader=response.body?.getReader();if(!reader)throw Error('Installed format metadata unavailable');
      const chunks=[];let length=0;
      try {for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>32768){await reader.cancel();throw Error('Installed format metadata exceeds bound');}chunks.push(value);}}
      finally {reader.releaseLock();}
      const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      if(hash!==pin.metadataSha256)throw Error('Installed format metadata changed');
      if(signal.aborted)throw new DOMException('Canceled','AbortError');
      return {provenance:pin.provenance,manifest:JSON.parse(new TextDecoder().decode(bytes))};
    },
    async loadClient(signal) {
      const {createFormatClient}=await import('/fixture/installed-formats/dist/index.js');
      if(signal.aborted)throw new DOMException('Canceled','AbortError');
      return createFormatClient();
    },
  }));
  root.after(controls.element);
  // BrowserEditor owns cancellation and disposal. Host owns only placement.
  return controls;
}
