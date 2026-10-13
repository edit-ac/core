import {markdownOptions} from './markdown.mjs';
import {createElement,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {EditorHost} from '@edit-ac/react';
import {localOptions} from './document.mjs';
import {retainRecovery,recoveryReports,downloadRecovery} from './recovery.mjs';
export let editor;
export const reactRoot=createRoot(document.querySelector('#editor'));
let unsubscribe;
const status=text=>{document.querySelector('#message').textContent=text;};
// Construct browser ports after the client entry loads, never during SSR.
export const ready=localOptions('react').then(async options=>{
  Object.assign(options, await markdownOptions());
  reactRoot.render(createElement(StrictMode,null,createElement(EditorHost,{options,
    onReady(value) { editor=value;unsubscribe?.();unsubscribe=editor.subscribe(state=>status(state.error?'Local save failed. Export recovery before closing.':state.localCommitted?'Saved locally. Remote durability is not confirmed.':'Ready offline. Remote durability is not confirmed.')); },
    onError() {status('Unable to open or save. Keep this tab open and export recovery.');},
    onDispose(result) {unsubscribe?.();retainRecovery(result);if(result.unsaved)status('Unsaved content retained. Export recovery before closing.');},
  })));
}).catch(()=>status('Unable to open local document. Existing data was preserved.'));
document.querySelector('#save').onclick=async()=>{try {await editor.flush({target:'local'});}catch {status('Local save failed. Export recovery before closing.');}};
document.querySelector('#export-recovery').onclick=()=>downloadRecovery([...recoveryReports,...(editor?.state.ready?[editor.recoveryExport()]:[])]);
export function close() {reactRoot.unmount();}
