import { createEditor, DocumentSearch, Spelling, type EditorOptions } from '@edit-ac/web';

/** Recovery identifies an existing document; initialization belongs to its host. */
export async function openLocal(root: HTMLElement, recovery: EditorOptions) {
  const spelling = Spelling.configure({ mode: 'platform' });
  const editor = createEditor(root, { ...recovery,
    extensions: [DocumentSearch.configure(), ...spelling.extensions],
    platform: spelling.platform,
    formatting: { marks: { bold: { shortcuts: false, controls: false } } },
  });
  await editor.ready;
  return editor;
}
