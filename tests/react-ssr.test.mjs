import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

test('React package imports and renders on the server without DOM, storage or WASM initialization', async()=>{
  const names=['window','document','indexedDB','navigator','fetch','WebAssembly'];
  const descriptors=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
  try {
    for(const name of names) Object.defineProperty(globalThis,name,{configurable:true,get(){throw Error(`SSR accessed ${name}`);}});
    const {EditorHost,useEditorState}=await import('@edit-ac/react');
    const options={identity:{documentId:'ssr'},databaseName:'ssr',assetUrl:'/never-load.wasm'};
    const html=renderToString(createElement(EditorHost,{options,attributes:{id:'server-host','aria-label':'Task'}}));
    assert.equal(html,'<div id="server-host" aria-label="Task"></div>');
    function Status(){assert.equal(useEditorState(null),null);return null;}
    assert.equal(renderToString(createElement(Status)),'');
  } finally {
    for(const [name,descriptor] of descriptors) if(descriptor) Object.defineProperty(globalThis,name,descriptor); else delete globalThis[name];
  }
});

test('React tooling and the peer range match the actually verified exact runtime',async()=>{
  const {readFile}=await import('node:fs/promises');
  const manifest=JSON.parse(await readFile('packages/react/package.json','utf8'));
  const {version}=await import('react'); const dom=await import('react-dom');
  assert.equal(version,'19.3.0'); assert.equal(dom.version,version); assert.equal(manifest.peerDependencies.react,'19.3.x');
  assert.equal(manifest.dependencies['@edit-ac/web'],'0.0.0'); assert.equal(manifest.private,true);
});
