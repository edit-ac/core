import { create } from './lexical-base.mjs';
import { createYjsBinding, createUndoManager, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from '@lexical/yjs';
import { UNDO_COMMAND, REDO_COMMAND, COMMAND_PRIORITY_EDITOR } from 'lexical';
import { Doc, persist } from './persistence.mjs';
export async function mount(root, fixture, options) {
  const adapter = create(root, fixture), doc = new Doc();
  // No remote users/cursors in this local transport profile. The binding still
  // needs the official provider-awareness interface.
  let state = null;
  const provider = { awareness: { getLocalState: () => state, getStates: () => new Map(), setLocalState: value => { state=value; },
    setLocalStateField: (key, value) => { state={ ...state, [key]: value }; }, on() {}, off() {} }, connect() {}, disconnect() {}, on() {}, off() {} };
  const binding = createYjsBinding({ editor: adapter.editor, id: 'comparison', doc, docMap: new Map([['comparison',doc]]) });
  const shared = binding.root.getSharedType();
  const observe = (events, transaction) => { if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events, false, () => {}); };
  shared.observeDeep(observe);
  adapter.cleanups.push(adapter.editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  }));
  const persistence = await persist(options.databaseName, doc);
  // Remote reconciliation is asynchronous; permit its queued discrete commit.
  await new Promise(resolve => setTimeout(resolve, 0));
  if (!adapter.text()) adapter.seed();
  await persistence.flush(); persistence.roundtrip();
  const history = createUndoManager(binding, shared);
  adapter.cleanups.push(adapter.editor.registerCommand(UNDO_COMMAND, () => { history.undo(); return true; }, COMMAND_PRIORITY_EDITOR),
    adapter.editor.registerCommand(REDO_COMMAND, () => { history.redo(); return true; }, COMMAND_PRIORITY_EDITOR));
  return { ...adapter, flush: persistence.flush,
    destroy: async () => { await persistence.flush(); shared.unobserveDeep(observe); history.destroy(); await adapter.destroy(); await persistence.destroy(); doc.destroy(); } };
}
