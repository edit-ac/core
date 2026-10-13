export async function prepareEditor(page) {
  await page.evaluate(async () => {
    const f = window.inputFixture, identity = f.engine.read().identity;
    await f.destroy(); window.fixtureDisposed = true;
    const module = await import('/web/index.js');
    window.mountBrowserEditor = module.mountEditor;
    window.editorOptions = { assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName:'browser-input',identity,indexedDB,locks:navigator.locks };
    window.selectEditor = (index, offset, end = offset) => {
      const e = window.activeEditor, nodes = e.read().visible.filter(n=>n.kind==='block');
      const a=e.selection.toDOM({node:nodes[index].id,offset,bias:'right'}), b=e.selection.toDOM({node:nodes[index].id,offset:end,bias:'left'});
      e.root.focus();document.getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset);e.selection.capture();
    };
  });
}
