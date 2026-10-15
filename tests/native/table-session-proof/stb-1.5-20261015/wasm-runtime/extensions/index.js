/** Version of the public API contract, independent of each descriptor's data version. */
export const EXTENSION_API_VERSION = 1;
export { ModuleRegistry, ModuleContractError } from './registry.js';
export { prepareModuleMigration, ModuleEvolutionError } from './evolution.js';
export { prepareExtensionProfile, ExtensionProfileActivation, ProfileError, FIRST_PARTY_FEATURES, FIRST_PARTY_PROFILES } from './profiles.js';
export { EXTENSION_TRANSFER_VERSION, EXTENSION_TRANSFER_MIME, ExtensionTransferRegistry, ExtensionTransferError, exportExtensionTransfer, importExtensionTransfer, extensionTransferRequest } from './transfer.js';
