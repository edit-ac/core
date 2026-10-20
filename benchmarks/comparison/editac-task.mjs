import { init } from '@edit-ac/core';
import { CheckpointStorage, createEditor, taskPreset } from '@edit-ac/web';
import { check, selectText } from './shared.mjs';
export async function mount(root, fixture, options) {
  const runtime = await init('/assets/editac-task/wasm/editac_wasm_bg.wasm');
  const key = `${options.databaseName}:identity`;
  let identity = JSON.parse(localStorage.getItem(key) ?? 'null');
  if (!identity) {
    const engine = runtime.createEngine({ profile: 'v5', documentId: crypto.randomUUID(), epoch: crypto.randomUUID(), nodes: fixture.blocks.map(b => ({ text: b.text })) });
    try {
      const nodes = engine.read().visible.filter(n => n.kind === 'block');
      const commit = request => { const plan = engine.prepare(request); try { const result = engine.commit(plan); if (result.caret) engine.releaseAnchor(result.caret); } finally { engine.releasePlan(plan); } };
      commit({ kind: 'format', origin: 'comparison:seed', marks: [], blocks: [{ targets: nodes.filter((_,i) => fixture.blocks[i].type === 'heading').map(n => n.id), attributes: { type: 'heading', level: 2 }, action: 'apply' }] });
      const commands = [];
      for (let i=0; i<nodes.length; i++) {
        if (fixture.blocks[i].type === 'code') commands.push({ type: 'setCode', owner: nodes[i].id, language: 'text' });
        if (fixture.blocks[i].type === 'list') { const targets = []; while (fixture.blocks[i]?.type === 'list') targets.push(nodes[i++].id); i--; commands.push({ type: 'wrap', targets, style: { type: 'unordered' } }); }
      }
      for (let i=0; i<commands.length; i+=32) commit({ kind: 'editor', origin: 'comparison:seed', commands: commands.slice(i,i+32) });
      identity = engine.read().identity;
      const storage = await CheckpointStorage.open(indexedDB, options.databaseName);
      try { await storage.publish(engine.checkpoint(), []); } finally { storage.close(); }
      localStorage.setItem(key, JSON.stringify(identity));
    } finally { engine.dispose(); }
  }
  const editor = createEditor(root, { assetUrl: '/assets/editac-task/wasm/editac_wasm_bg.wasm', databaseName: options.databaseName,
    identity, indexedDB, locks: navigator.locks, ...taskPreset() });
  await editor.ready;
  const blocks = () => editor.read().visible.filter(n => n.kind === 'block');
  const element = index => root.querySelector(`[data-node-id="${CSS.escape(blocks()[index].id)}"]`);
  let selected = [0,0];
  const at = fn => { const [index, offset] = selected, anchor = editor.anchor(blocks()[index].id, offset);
    try { return fn(anchor); } finally { editor.releaseAnchor(anchor); } };
  const textCommit = command => {
    const origin = command.type === 'insert' ? 'comparison:insert' : 'comparison:delete';
    return editor.commit(options.textCommandRoute === 'editor'
      ? { kind: 'editor', origin, commands: [command] }
      : { kind: 'text', origin, command });
  };
  return {
    text: () => blocks().map(n => n.runs.map(r => r.text).join('')).join(''),
    select: (index,offset) => { selected=[index,offset]; selectText(element(index),offset); },
    insert: text => { at(anchor => textCommit({ type: 'insert', at: anchor, text })); selected[1]+=text.length; },
    delete: () => { const [index, offset] = selected, anchor = editor.anchor(blocks()[index].id,offset-1), focus=editor.anchor(blocks()[index].id,offset);
      try { textCommit({ type: 'delete', range: { anchor,focus } }); selected[1]--; }
      finally { editor.releaseAnchor(anchor); editor.releaseAnchor(focus); }
    },
    flush: () => editor.flush({ target: 'local' }),
    destroy: async () => { await editor.destroy({ policy: 'flush' }); check(!editor.state.ready, 'edit.ac remained mounted'); root.replaceChildren(); }
  };
}
