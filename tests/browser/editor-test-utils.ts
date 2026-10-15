export async function prepareEditor(page) {
  await page.evaluate(async () => {
    const f = window.inputFixture, identity = f.engine.read().identity;
    await f.destroy(); window.fixtureDisposed = true;
    const module = await import('/web/index.js');
    window.mountBrowserEditor = module.mountEditor;
    window.editorOptions = { assetUrl:'/core/wasm/editac_wasm_bg.wasm',databaseName:'browser-input',identity,indexedDB,locks:navigator.locks };
    window.selectEditor = (index, offset, end = offset) => {
      const e = window.activeEditor, nodes = e.read().visible.filter(n=>n.kind==='block');
      const block = e.root.querySelector(`[data-node-id="${nodes[index].id}"]`);
      if (!block) throw Error('Missing rendered selection target');
      const point = offset => {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode;
          if (offset <= text.length) return { node: text, offset };
          offset -= text.length;
        }
        if (offset === 0) return { node: block, offset: 0 };
        throw Error('Selection offset outside rendered text');
      };
      const a=point(offset), b=point(end);
      e.root.focus();document.getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset);
      document.dispatchEvent(new Event('selectionchange'));
    };
  });
}
