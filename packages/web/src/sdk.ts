import { mountEditor, type BrowserEditor, type EditorOptions } from './editor.js';

export type TaskPresetOptions = Pick<EditorOptions, 'typingShortcuts' | 'plainTextPolicy' | 'plainPasteControl' | 'contentCodecs'>;

/** Explicit defaults; hosts opt into content/module providers separately. */
export function taskPreset(options: TaskPresetOptions = {}): TaskPresetOptions & { preset: 'task' } {
  return { preset: 'task', typingShortcuts: true, plainTextPolicy: 'markdown', plainPasteControl: true, ...options };
}

/** Returns a lifecycle handle immediately. Await ready before commands or input.
 * Opening requires an existing checkpoint; creation is an explicit host action. */
export function createEditor(root: HTMLElement, options: EditorOptions): BrowserEditor {
  return mountEditor(root, options);
}
