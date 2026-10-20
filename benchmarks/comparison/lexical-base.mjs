import { createEditor, $getRoot, $createParagraphNode, $createTextNode, $getSelection, $isRangeSelection, UNDO_COMMAND, REDO_COMMAND, HISTORY_PUSH_TAG } from 'lexical';
import { registerRichText, HeadingNode, QuoteNode, $createHeadingNode } from '@lexical/rich-text';
import { CodeNode, $createCodeNode } from '@lexical/code';
import { ListNode, ListItemNode, $createListNode, $createListItemNode, registerList } from '@lexical/list';
import { LinkNode } from '@lexical/link';
import { check } from './shared.mjs';
export function create(root, fixture) {
  const editor = createEditor({ namespace: 'comparison', nodes: [HeadingNode, QuoteNode, CodeNode, ListNode, ListItemNode, LinkNode],
    onError: error => { throw error; }, theme: { code: 'code', text: { bold: 'bold', italic: 'italic' } } });
  const cleanups = [registerRichText(editor), registerList(editor)]; editor.setRootElement(root);
  const leaves = () => { const result = []; const walk = node => { if (node.getChildren && !node.getChildren().some(child => child.getChildren)) result.push(node); else node.getChildren?.().forEach(walk); }; $getRoot().getChildren().forEach(walk); return result; };
  const update = fn => editor.update(fn, { discrete: true, tag: HISTORY_PUSH_TAG });
  return { editor, cleanups,
    seed: () => update(() => { const target = $getRoot(); target.clear(); let list;
      for (const b of fixture.blocks) { if (b.type !== 'list') list = undefined;
        const node = b.type === 'heading' ? $createHeadingNode('h2') : b.type === 'code' ? $createCodeNode('text') : b.type === 'list' ? $createListItemNode() : $createParagraphNode();
        node.append($createTextNode(b.text));
        if (b.type === 'list') { if (!list) { list = $createListNode('bullet'); target.append(list); } list.append(node); } else target.append(node);
      }
    }),
    text: () => editor.getEditorState().read(() => leaves().map(node => node.getTextContent()).join('')),
    select: (index, offset) => update(() => { const node = leaves()[index]; let remaining = offset, selected;
      for (const text of node.getAllTextNodes()) { if (remaining <= text.getTextContentSize()) { text.select(remaining, remaining); selected = true; break; } remaining -= text.getTextContentSize(); }
      check(selected, 'Lexical selection unmapped');
    }),
    insert: text => update(() => { const s = $getSelection(); check($isRangeSelection(s), 'Lexical missing selection'); s.insertText(text); }),
    delete: () => update(() => { const s = $getSelection(); check($isRangeSelection(s), 'Lexical missing selection'); s.deleteCharacter(true); }),
    bold: () => update(() => { const s = $getSelection(); s.focus.offset = s.anchor.offset+3; s.formatText('bold'); }),
    undo: () => { check(editor.dispatchCommand(UNDO_COMMAND), 'Lexical undo rejected'); },
    redo: () => { check(editor.dispatchCommand(REDO_COMMAND), 'Lexical redo rejected'); },
    flush: async () => {},
    destroy: async () => { cleanups.splice(0).forEach(fn => fn()); editor.setRootElement(null); root.replaceChildren(); }
  };
}
