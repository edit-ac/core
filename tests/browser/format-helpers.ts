import assert from 'node:assert/strict';
export async function selectAll(page) {
  await page.evaluate(() => {
    const f = window.inputFixture, nodes = f.engine.read().visible.filter(n => n.kind === 'block');
    const a = f.selection.toDOM({node:nodes[0].id,offset:0,bias:'right'});
    const last = nodes.at(-1), b = f.selection.toDOM({node:last.id,offset:last.runs.map(r=>r.text).join('').length,bias:'left'});
    f.root.focus(); document.getSelection().setBaseAndExtent(a.node,a.offset,b.node,b.offset); f.selection.capture();
  });
}
export async function paste(page, flavors, options = {}) {
  return page.evaluate(({flavors, options}) => window.inputFixture.protocol.clipboard.paste({getData:m=>flavors[m]??''},options), {flavors,options});
}
export async function state(page, fact) {
  const s = await page.evaluate(async () => {
    const f=window.inputFixture;
    return {...await f.state(),nodes:f.engine.read().visible,result:f.protocol.clipboard.last,diagnostics:f.protocol.clipboard.diagnostics,recovery:f.protocol.clipboard.recovery};
  });
  fact.snapshots.push(s); assert.deepEqual(s.errors,[]); return s;
}
