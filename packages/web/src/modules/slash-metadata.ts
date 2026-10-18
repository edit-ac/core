import type { SlashCommand } from './slash.js';

/** Copy and validate host metadata before any asynchronous attachment. */
export function prepareSlashCommands(commands: readonly SlashCommand[]) {
  if (commands.length > 500) throw Error('Too many slash commands');
  const ids = new Set<string>();
  return commands.map(command => {
    if (!/^[a-zA-Z][\w.-]{0,63}$/.test(command.id) || ids.has(command.id) || !command.label || command.label.length > 128 || typeof command.prepare !== 'function' ||
        (command.disabled !== undefined && (!command.disabled || command.disabled.length > 256)) || (command.keywords?.length ?? 0) > 16 || command.keywords?.some(k => k.length > 64)) throw Error('Invalid slash command');
    ids.add(command.id);
    return Object.freeze({ ...command, keywords: Object.freeze([...(command.keywords ?? [])]) });
  });
}
