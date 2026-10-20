import { check, nextFrame } from './shared.mjs';
const root = document.querySelector('#editor');
let adapter;
const expected = () => window.fixture.blocks.map(b => b.text).join('');
const assertDocument = text => {
  check(adapter.text() === text, 'Semantic text mismatch');
  // textContent excludes the renderer's block separator presentation and tests
  // the actual projected text as well as the editor model.
  check(root.textContent === text, 'Rendered text mismatch');
  check(root.querySelector('h2') && root.querySelector('pre,.code') && root.querySelector('ul'), 'Mixed schema projection missing');
};
async function open() {
  check(new TextEncoder().encode(expected()).length === window.fixture.textBytes, 'Fixture UTF-8 byte count changed in transport');
  check(expected().length === window.fixture.textUtf16, 'Fixture UTF-16 size changed in transport');
  const driver = await import(`/assets/${window.profile}/adapter.js`);
  adapter = await driver.mount(root, window.fixture, { databaseName: window.databaseName, textCommandRoute: window.textCommandRoute });
}
async function probe(start) {
  const original = window.fixture.blocks[0].text;
  adapter.select(0,0); adapter.insert('x'); root.getBoundingClientRect();
  const ms = performance.now()-start;
  assertDocument(`x${expected()}`);
  adapter.delete(); root.getBoundingClientRect(); assertDocument(expected());
  check(window.fixture.blocks[0].text === original, 'Fixture mutated');
  return ms;
}
window.comparison = {
  prepare: async () => { try { await open(); assertDocument(expected()); await adapter.flush(); } finally { await adapter?.destroy(); adapter=undefined; } },
  run: async samples => {
    const metrics = {}, record = (name, value) => (metrics[name] ??= []).push(value);
    try {
      const cold = performance.now(); await open(); root.getBoundingClientRect();
      record('cold.projected-layout', performance.now()-cold);
      record('cold.accepted-edit', await probe(cold));
      await adapter.flush(); await adapter.destroy(); adapter=undefined;
      const warm = performance.now(); await open(); root.getBoundingClientRect();
      record('warm.projected-layout', performance.now()-warm);
      record('warm.accepted-edit', await probe(warm));
      assertDocument(expected());
      for (const position of ['start','middle','end']) {
        const index = position === 'start' ? 0 : position === 'middle' ? Math.floor(window.fixture.blocks.length/2) : window.fixture.blocks.length-1;
        const text = window.fixture.blocks[index].text;
        let offset = position === 'start' ? 0 : position === 'middle' ? Math.floor(text.length/2) : text.length;
        if (/[\uDC00-\uDFFF]/.test(text[offset] ?? '')) offset--;
        const inserted = window.fixture.blocks.map((b,i) => i === index ? `${text.slice(0,offset)}x${text.slice(offset)}` : b.text).join('');
        for (let sample=0; sample<samples; sample++) {
          adapter.select(index,offset); await nextFrame();
          let start=performance.now(); adapter.insert('x'); root.getBoundingClientRect(); record(`insert.${position}`, performance.now()-start);
          assertDocument(inserted);
          adapter.select(index,offset+1);
          start=performance.now(); adapter.delete(); root.getBoundingClientRect(); record(`delete.${position}`, performance.now()-start);
          assertDocument(expected());
          await nextFrame();
        }
      }
      if (window.durable) {
        adapter.select(0,0); adapter.insert('R'); assertDocument(`R${expected()}`);
        const start=performance.now(); await adapter.flush(); record('local.flush',performance.now()-start);
        await adapter.destroy(); adapter=undefined;
        const restore=performance.now(); await open(); root.getBoundingClientRect(); record('local.restore',performance.now()-restore); assertDocument(`R${expected()}`);
        adapter.select(0,1); adapter.delete(); await adapter.flush(); assertDocument(expected());
      }
      return { metrics, assertions: { fixture: true, semanticAndDomEdits: true, localRestore: window.durable ? true : 'Not applicable' }, textBytes: window.fixture.textBytes };
    } finally { await adapter?.destroy(); adapter=undefined; }
  }
};
