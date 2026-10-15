// Explicit feature-cost configurations. No optional provider is installed by these presets.
export const presets = Object.freeze({
  baseline: { id: 'baseline', sdkPreset: 'minimal', featureSet: ['engine', 'web-input', 'renderer', 'local-persistence'],
    options: { preset: 'minimal', typingShortcuts: false, plainPasteControl: false, plainTextPolicy: 'literal' },
    providers: [] },
  task: { id: 'task', sdkPreset: 'task', featureSet: ['engine', 'web-input', 'renderer', 'local-persistence', 'typing-shortcuts', 'plain-paste-control'],
    options: { preset: 'task', typingShortcuts: true, plainPasteControl: true }, providers: [] },
});
export function presetOptions(name, sdk) {
  if (!presets[name]) throw Error(`Unknown preset: ${name}`);
  return name === 'task' ? sdk.taskPreset() : { ...presets[name].options };
}
