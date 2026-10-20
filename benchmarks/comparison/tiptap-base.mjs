import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { check, domFixture } from './shared.mjs';
export function create(root, fixture, extensions = [], durable = false) {
  const source = document.createElement('div'); domFixture(source, fixture);
  const editor = new Editor({ element: root, extensions: [StarterKit.configure({ undoRedo: durable ? false : { depth: 100 },
    horizontalRule: false, strike: false, underline: false, dropcursor: false, gapcursor: false,
    codeBlock: { languageClassPrefix: null }, link: { openOnClick: false } }), ...extensions],
    content: durable ? undefined : source.innerHTML, parseOptions: { preserveWhitespace: 'full' }, injectCSS: false, editorProps: { attributes: { spellcheck: 'false' } } });
  const positions = () => { const result = []; editor.state.doc.descendants((node, pos) => { if (node.isTextblock) result.push(pos+1); }); return result; };
  return { editor, initialHTML: source.innerHTML,
    text: () => editor.state.doc.textBetween(0, editor.state.doc.content.size, '', ''),
    select: (index, offset) => { editor.commands.setTextSelection(positions()[index]+offset); editor.view.focus(); },
    insert: text => check(editor.commands.insertContent(text, { parseOptions: { preserveWhitespace: 'full' } }), 'Tiptap insert rejected'),
    delete: () => { const pos = editor.state.selection.from; check(editor.commands.deleteRange({ from: pos-1, to: pos }), 'Tiptap delete rejected'); },
    bold: () => { const from = editor.state.selection.from; editor.commands.setTextSelection({ from, to: from+3 }); check(editor.commands.toggleBold(), 'Tiptap format rejected'); },
    undo: () => check(editor.commands.undo(), 'Tiptap undo rejected'), redo: () => check(editor.commands.redo(), 'Tiptap redo rejected'),
    flush: async () => {}, destroy: async () => { editor.destroy(); root.replaceChildren(); }
  };
}
