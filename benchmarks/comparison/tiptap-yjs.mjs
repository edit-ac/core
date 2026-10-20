import Collaboration from '@tiptap/extension-collaboration';
import { create } from './tiptap-base.mjs';
import { Doc, persist } from './persistence.mjs';
export async function mount(root, fixture, options) {
  const doc = new Doc();
  const adapter = create(root, fixture, [Collaboration.configure({ document: doc })], true);
  const persistence = await persist(options.databaseName, doc);
  if (!adapter.text()) adapter.editor.commands.setContent(adapter.initialHTML, { parseOptions: { preserveWhitespace: 'full' } });
  await persistence.flush(); persistence.roundtrip();
  return { ...adapter, flush: persistence.flush, destroy: async () => { await persistence.flush(); await adapter.destroy(); await persistence.destroy(); doc.destroy(); } };
}
