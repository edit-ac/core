// FND-1.12: real pinned Yjs transport and read-only frozen-schema projection.
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { roots, constructSeed, seed, applyAdmitted } from './mapping.mjs';
export const cases = ['move-edit', 'move-move', 'delete-edit', 'edit-edit', 'split-edit', 'join-edit', 'split-join', 'cycle-edit', 'js-move-edit', 'js-delete-edit', 'js-split-edit', 'js-join-edit', 'js-edit-edit'];
export const orders = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
export const read = (dir, name) => new Uint8Array(readFileSync(join(dir, name)));
const json = (dir, name, value) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
export function replica(id) { const doc = new Y.Doc(); doc.clientID = id; roots(doc); return doc; }
export function apply(doc, bytes, origin = 'remote') {
  assert.equal(applyAdmitted(doc, seed.metadata, seed.metadata, bytes, origin), 'accepted');
}
const text = (doc, id) => doc.getMap('registry-texts').get(id);
const identity = t => [t._item.id.client, t._item.id.clock]; // Fixture-only pinned identity inspection.
const ascii = (a,b) => a < b ? -1 : a > b ? 1 : 0;
function runs(t, start, end) {
  let offset = 0;
  return t.toDelta().flatMap(run => {
    assert.equal(typeof run.insert, 'string');
    const left = Math.max(start, offset), right = Math.min(end, offset + run.insert.length);
    const part = run.insert.slice(left-offset, right-offset);
    offset += run.insert.length;
    return right > left ? [[part, Object.entries(run.attributes ?? {}).map(([k,v]) => [k, String(v)]).sort(([a],[b]) => ascii(a,b))]] : [];
  });
}
export function project(doc) {
  const before = Y.encodeStateAsUpdate(doc);
  const maps = roots(doc), kinds = maps['registry-parents'], texts = maps['registry-texts'];
  const ids = [...kinds.keys()].sort(ascii), nodes = new Map();
  for (const id of ids) {
    const raw = maps['registry-placements'].get(id);
    let [parent, order] = Array.isArray(raw) && raw.length === 2 && typeof raw[0] === 'string'
      && Number.isInteger(raw[1]) && raw[1] >= 0 && raw[1] <= 4294967295 ? raw : ['@root', 0];
    if (parent !== '@root' && kinds.get(parent) !== 'list') parent = '@root';
    nodes.set(id, { parent, order });
    assert.ok(texts.get(id) instanceof Y.XmlText);
  }
  let visits = 0;
  for (const id of ids) {
    const path = [], seen = new Map(); let current = id;
    while (current !== '@root') {
      if (seen.has(current)) { nodes.get(path.slice(seen.get(current)).sort(ascii)[0]).parent = '@root'; break; }
      assert.ok(path.length < ids.length); seen.set(current, path.length); path.push(current);
      current = nodes.get(current).parent; visits++;
    }
  }
  assert.ok(visits <= ids.length ** 2);
  const a = text(doc, 'block-1'), b = text(doc, 'block-2');
  assert.equal(texts.size, 2, 'no copied text');
  const span = (source, start, end) => ({ source, identity: identity(text(doc, source)), start, end });
  const block = (id, source, spans, extra = 0) => ({ id, ...nodes.get(source), order: nodes.get(source).order + extra, spans });
  const layout = maps['probe-split-join'].get('pair'); let blocks;
  switch (layout[0]) {
    case 'original': blocks = [block('block-1','block-1',[span('block-1',0,a.length)]),block('block-2','block-2',[span('block-2',0,b.length)])]; break;
    case 'join': blocks = [block('block-1','block-1',[span('block-1',0,a.length),span('block-2',0,b.length)])]; break;
    case 'split': {
      if (nodes.get('block-1').order === 4294967295) {
        const error = new RangeError('derived order out of range');
        error.recoveryUpdate = before;
        throw error;
      }
      assert.ok(layout[1] instanceof Uint8Array);
      const cut = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(layout[1]), doc);
      assert.ok(cut && cut.type === a); const n = cut.index;
      blocks = [block('block-1','block-1',[span('block-1',0,n)]),block('block-split','block-1',[span('block-1',n,a.length)],1),block('block-2','block-2',[span('block-2',0,b.length)])]; break;
    }
    default: throw Error('unsupported ownership');
  }
  for (const source of ids) {
    const spans = blocks.flatMap(b => b.spans).filter(s => s.source === source).sort((a,b) => a.start-b.start);
    let end = 0; for (const s of spans) { assert.equal(s.start,end); end=s.end; } assert.equal(end,text(doc,source).length);
  }
  const deleted = maps['delete-probe-tombstones'];
  const visible = [], recovery = [];
  for (const b of blocks) for (const hidden of [false,true]) {
    const spans = b.spans.filter(s => (deleted.get(b.id) === true || deleted.get(s.source) === true) === hidden);
    if (spans.length) (hidden ? recovery : visible).push({ ...b, spans, runs: spans.flatMap(s => runs(text(doc,s.source),s.start,s.end)) });
  }
  const visibleIds = new Set(visible.map(b => b.id));
  for (const b of visible) if (b.parent !== '@root' && !visibleIds.has(b.parent)) b.parent='@root';
  const children = parent => visible.filter(b => b.parent === parent).sort((a,b) => a.order-b.order || ascii(a.id,b.id));
  const ordered = [], stack = children('@root').reverse();
  while (stack.length) { const b=stack.pop(); ordered.push(b); stack.push(...children(b.id).reverse()); assert.ok(ordered.length <= visible.length); }
  assert.equal(ordered.length,visible.length);
  const result = { visible: ordered, recovery, identities: ids.map(id => [id,identity(text(doc,id))]) };
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before, 'projection emits no repair');
  return result;
}
const anchorSpecs = [['block-1',3,-1],['block-1',3,0],['block-1',4,0],['block-2',1,0]];
export function writeAnchors(doc, dir, prefix) {
  anchorSpecs.forEach(([id,index,assoc],i) => writeFileSync(join(dir,`${prefix}-anchor-${i}.bin`),Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text(doc,id),index,assoc))));
}
export function resolveAnchors(doc, dir, prefix) {
  const p=project(doc);
  return anchorSpecs.map(([source,,assoc],i) => {
    const rel=Y.decodeRelativePosition(read(dir,`${prefix}-anchor-${i}.bin`));
    const pos=Y.createAbsolutePositionFromRelativePosition(rel,doc);
    assert.ok(pos && pos.type === text(doc,source)); assert.equal(pos.assoc,assoc);
    const candidates=[];
    for (const b of [...p.visible,...p.recovery]) {
      let offset=0;
      for (const s of b.spans) {
        if (s.source === source && pos.index >= s.start && pos.index <= s.end) candidates.push([b.id,offset+pos.index-s.start]);
        offset += s.end-s.start;
      }
    }
    const owner = assoc < 0 ? candidates[0] : candidates.at(-1);
    return { source, identity: identity(pos.type), index: pos.index, assoc, owner, hidden: p.recovery.some(b => b.id === owner[0] && b.spans.some(s => s.source === source)) };
  });
}
export function mutate(doc, name, side) {
  const scenarioName = name.startsWith('js-') ? name.slice(3) : name;
  const structural = name.startsWith('js-') ? side === 'js' : side === 'rust';
  if (structural && ['split-edit', 'split-join'].includes(scenarioName)) {
    const placement = doc.getMap('registry-placements').get('block-1');
    if (placement[1] === 4294967295) throw new RangeError('derived order out of range');
  }
  const placements=doc.getMap('registry-placements'), layout=doc.getMap('probe-split-join');
  const mirrored=name.startsWith('js-');
  const scenario=mirrored ? name.slice(3) : name;
  const role=mirrored ? (side==='rust' ? 'js' : 'rust') : side;
  const edit = () => { text(doc,'block-1').insert(3,side === 'rust' ? 'R' : 'J',{ [side === 'rust' ? 'italic' : 'underline']: true }); };
  doc.transact(() => {
    if (role === 'js') {
      if (scenario === 'move-move') placements.set('block-1',['@root',9]);
      else if (scenario === 'split-join') layout.set('pair',['join']);
      else edit();
    } else {
      switch (scenario) {
        case 'move-edit': placements.set('block-1',['block-2',7]); break;
        case 'move-move': placements.set('block-1',['block-2',7]); break;
        case 'delete-edit': doc.getMap('delete-probe-tombstones').set('block-1',true); break;
        case 'edit-edit': edit(); text(doc,'block-1').delete(4,1); break;
        case 'split-edit': case 'split-join': layout.set('pair',['split',Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text(doc,'block-1'),3,-1))]); break;
        case 'join-edit': layout.set('pair',['join']); break;
        case 'cycle-edit': placements.set('block-1',['block-2',2]); placements.set('block-2',['block-1',3]); break;
        default: throw Error(name);
      }
    }
  },`local:${name}`);
}
function checkExpected(doc,name) {
  const mirrored=name.startsWith('js-');
  name=mirrored ? name.slice(3) : name;
  const letter=mirrored ? 'R' : 'J';
  const p=project(doc), content=b => b.runs.map(r=>r[0]).join('');
  const retained=[...p.visible,...p.recovery].flatMap(b=>b.spans.map(s=>runs(text(doc,s.source),s.start,s.end).map(r=>r[0]).join(''))).join('');
  assert.ok(retained.includes('😀')); assert.ok(retained.includes('אב'));
  assert.equal(p.identities.length,2);
  const allRuns=[...p.visible,...p.recovery].flatMap(b=>b.runs);
  assert.ok(allRuns.some(([s,m])=>s.includes('😀') && m.some(([k,v])=>k==='bold' && v==='true')));
  assert.ok(allRuns.some(([s,m])=>s.includes('אב') && m.some(([k,v])=>k==='code' && v==='true')));
  if (!['move-move','split-join'].includes(name)) assert.ok(allRuns.some(([s,m])=>s.includes(letter) && m.some(([k,v])=>k===(mirrored ? 'italic' : 'underline') && v==='true')));
  if (name==='edit-edit') assert.ok(allRuns.some(([s,m])=>s.includes('R') && m.some(([k,v])=>k==='italic' && v==='true')));
  if (name === 'delete-edit') { assert.deepEqual(p.visible.map(b=>b.id),['block-2']); assert.equal(content(p.recovery[0]),`a😀${letter}b`); }
  if (name === 'move-edit') { assert.deepEqual(p.visible.map(b=>[b.id,b.parent,b.order]),[['block-2','@root',1],['block-1','block-2',7]]); }
  if (name === 'move-move') { assert.deepEqual(p.visible.map(b=>[b.id,b.parent,b.order]),[['block-2','@root',1],['block-1','@root',9]]); }
  if (name === 'edit-edit') assert.equal(content(p.visible[0]),'a😀RJ');
  if (name === 'split-edit') assert.deepEqual(p.visible.map(b=>[b.id,content(b)]),[['block-1','a😀'],['block-2','cאבd'],['block-split',`${letter}b`]]);
  if (name === 'join-edit') { assert.equal(p.visible.length,1); assert.equal(content(p.visible[0]),`a😀${letter}bcאבd`); }
  if (name === 'split-join') { assert.equal(p.visible.length,1); assert.equal(content(p.visible[0]),'a😀bcאבd'); }
  if (name === 'cycle-edit') assert.deepEqual(p.visible.map(b=>[b.id,b.parent]),[['block-1','@root'],['block-2','block-1']]);
  return p;
}
export function generateJS(dir) {
  const seedDoc=constructSeed(); writeFileSync(join(dir,'js-seed.bin'),Y.encodeStateAsUpdate(seedDoc)); seedDoc.destroy();
  for (const init of ['rust','js']) for (const name of cases) {
    const prefix=`${init}-${name}`, doc=replica(202); apply(doc,read(dir,`${init}-seed.bin`),'restore');
    writeAnchors(doc,dir,`${prefix}-js`); const sv=Y.encodeStateVector(doc);
    mutate(doc,name,'js'); writeFileSync(join(dir,`${prefix}-js.bin`),Y.encodeStateAsUpdate(doc,sv)); doc.destroy();
  }
}
export function verify(dir) {
  for (const init of ['rust','js']) for (const name of cases) {
    const prefix=`${init}-${name}`; let expected;
    for (const order of orders) {
      const doc=replica(303);
      const updates=[`${init}-seed.bin`,`${prefix}-rust.bin`,`${prefix}-js.bin`];
      try {
        for (const i of order) { apply(doc,read(dir,updates[i])); apply(doc,read(dir,updates[i])); }
        const p=checkExpected(doc,name);
        const baseline=replica(600);
        try { apply(baseline,read(dir,`${init}-seed.bin`),'restore'); assert.deepEqual(p.identities,project(baseline).identities,'retained initializer identities'); }
        finally { baseline.destroy(); }
        const anchors=resolveAnchors(doc,dir,`${prefix}-rust`);
        const scenario=name.startsWith('js-') ? name.slice(3) : name;
        const indices=scenario === 'edit-edit' ? [3,5,5,1] : ['move-move','split-join'].includes(scenario) ? [3,3,4,1] : [3,4,5,1];
        assert.deepEqual(anchors.map(a=>a.index),indices);
        assert.deepEqual(anchors.map(a=>a.hidden),scenario === 'delete-edit' ? [true,true,true,false] : [false,false,false,false]);
        assert.deepEqual(anchors,resolveAnchors(doc,dir,`${prefix}-js`));
        const canonical={...p,anchors};
        if (expected) assert.deepEqual(canonical,expected); else expected=canonical;
        for (const i of order.toReversed()) apply(doc,read(dir,updates[i]),'restore');
        assert.deepEqual(project(doc),p);
        const restored=replica(404);
        try { apply(restored,Y.encodeStateAsUpdate(doc),'restore'); assert.deepEqual(project(restored),p); assert.deepEqual(resolveAnchors(restored,dir,`${prefix}-rust`),anchors); }
        finally { restored.destroy(); }
      } finally { doc.destroy(); }
    }
    // Fresh restored peers receive missing operations through state-vector deltas.
    for (const side of ['rust','js']) {
      const doc=replica(side === 'rust' ? 501 : 502);
      try { apply(doc,read(dir,`${init}-seed.bin`)); apply(doc,read(dir,`${prefix}-${side}.bin`));
        const observer=replica(505);
        try { for (const file of [`${init}-seed.bin`,`${prefix}-rust.bin`,`${prefix}-js.bin`]) apply(observer,read(dir,file));
          const delta=Y.encodeStateAsUpdate(observer,Y.encodeStateVector(doc)); apply(doc,delta); apply(doc,delta);
          assert.deepEqual(project(doc),{visible:expected.visible,recovery:expected.recovery,identities:expected.identities});
        } finally { observer.destroy(); }
      } finally { doc.destroy(); }
    }
    json(dir,`${prefix}-js.json`,expected);
    const rustFile=join(dir,`${prefix}-rust.json`);
    if (process.argv[2] === 'compare' || process.argv[2] === 'verify-final') assert.deepEqual(JSON.parse(readFileSync(rustFile)),expected, prefix);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode,dir]=process.argv.slice(2);
  if (mode === 'generate-js') generateJS(dir);
  else if (['verify','compare','verify-final'].includes(mode)) verify(dir);
  else throw Error(`unknown mode ${mode}`);
}
