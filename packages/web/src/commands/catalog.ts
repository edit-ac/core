import type { KeyboardAction } from '../input/keyboard.js';

/** One portable name/key catalog. Every route delegates to KeyboardInput and the
 * same prepared engine commands; these descriptors contain no edit semantics. */
export const commandCatalog = Object.freeze(Object.freeze([
  { id: 'enter', label: 'Insert paragraph', aliases: ['insertParagraph'], key: 'Enter' },
  { id: 'break', label: 'Insert line break', aliases: ['insertLineBreak'], key: 'Shift+Enter' },
  { id: 'backward', label: 'Delete backward', aliases: ['deleteContentBackward'], key: 'Backspace' },
  { id: 'forward', label: 'Delete forward', aliases: ['deleteContentForward'], key: 'Delete' },
  { id: 'indent', label: 'Indent', aliases: [], key: 'Tab' },
  { id: 'outdent', label: 'Outdent', aliases: [], key: 'Shift+Tab' },
  { id: 'bold', label: 'Bold', aliases: ['toggleBold'], key: 'Primary+b' },
  { id: 'italic', label: 'Italic', aliases: ['toggleItalic'], key: 'Primary+i' },
  { id: 'underline', label: 'Underline', aliases: ['toggleUnderline'], key: 'Primary+u' },
  { id: 'strike', label: 'Strikethrough', aliases: ['toggleStrike'], key: 'Primary+Shift+x' },
  { id: 'code', label: 'Inline code', aliases: ['toggleCode'], key: null },
  { id: 'link', label: 'Edit link', aliases: ['editLink'], key: 'Primary+k' },
  { id: 'undo', label: 'Undo', aliases: ['historyUndo'], key: 'Primary+z' },
  { id: 'redo', label: 'Redo', aliases: ['historyRedo'], key: 'Primary+Shift+z' },
  { id: 'replace', label: 'Replace supplied target', aliases: ['insertReplacementText'], key: null },
] as const).map(c => Object.freeze({ ...c, aliases: Object.freeze(c.aliases) })));
export type PortableCommand = KeyboardAction | 'replace';
export interface ShortcutProfile {
  /** Canonical chords owned by the host/OS/assistive technology. */
  reserved?: readonly string[];
  /** Chord -> registered command or null to leave it with its native owner. */
  remap?: Readonly<Record<string, string | null>>;
}
export interface CapturedCommand {
  readonly active: boolean;
  execute(text?: string): import('../input/keyboard.js').CommandResult;
  dispose(): void;
}
export function resolveCommand(name: string): PortableCommand | undefined {
  return commandCatalog.find(c => c.id === name || (c.aliases as readonly string[]).includes(name))?.id;
}
export function shortcutCommand(chord: string, profile: ShortcutProfile, windowsRedo = false): KeyboardAction | undefined {
  if (profile.reserved?.includes(chord)) return undefined;
  const mapped = Object.hasOwn(profile.remap ?? {}, chord) ? profile.remap![chord] :
    commandCatalog.find(c => c.key === chord)?.id ?? (windowsRedo && chord === 'Primary+y' ? 'redo' : undefined);
  const command = mapped == null ? undefined : resolveCommand(mapped);
  return command === 'replace' ? undefined : command;
}
