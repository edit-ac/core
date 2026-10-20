import { create } from './lexical-base.mjs';
import { registerHistory, createEmptyHistoryState } from '@lexical/history';
export async function mount(root, fixture) {
  const adapter = create(root, fixture); adapter.seed();
  adapter.cleanups.push(registerHistory(adapter.editor, createEmptyHistoryState(), 300)); return adapter;
}
