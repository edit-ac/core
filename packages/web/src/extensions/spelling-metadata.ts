import { ExtensionConfigurationError } from './contract.js';
import type { ConfiguredExtensionV1, PlatformPreferencesV1 } from './contract.js';
export const custom = new WeakSet<ConfiguredExtensionV1>();
export function admitSpelling(policy: PlatformPreferencesV1 | undefined, extensions: readonly ConfiguredExtensionV1[]) {
  const configured = extensions.filter(extension => custom.has(extension));
  if (policy?.spellcheck === 'custom' ? configured.length !== 1 : configured.length !== 0)
    throw new ExtensionConfigurationError('missing-checker', 'editor', 'platform.spellcheck', 'Use Spelling.configure with an explicit checker and overlap choice; keep its platform and extensions together');
}
