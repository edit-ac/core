/** Version of the public API contract, independent of each descriptor's data version. */
export declare const EXTENSION_API_VERSION: 1;
export { ModuleRegistry, ModuleContractError } from './registry.js';
export type { ModuleDefinition, ModulePresentation } from './registry.js';
export type { ModuleDefinition as ModuleDefinitionV1 } from './registry.js';
export type { EditorCommand as ExtensionCommandV1, PrepareRequest, CommitResult, EngineHandle, StableRange, FragmentBlock, FragmentRun, MarkdownCodec as MarkdownCodecV1, MarkdownExtension as MarkdownExtensionV1, MarkdownOptions, PreparedMarkdown, MarkdownExport, PatchSubscription, } from '../engine.js';
export { prepareModuleMigration, ModuleEvolutionError } from './evolution.js';
export type { ModuleEvolution, PreparedModuleMigration } from './evolution.js';
export { prepareExtensionProfile, ExtensionProfileActivation, ProfileError, FIRST_PARTY_FEATURES, FIRST_PARTY_PROFILES } from './profiles.js';
export type { ProfileFeature, ExtensionProfile, ProfileEnvironment, PreparedProfile, ProfileResource, ProfileLoader } from './profiles.js';
export { EXTENSION_TRANSFER_VERSION, EXTENSION_TRANSFER_MIME, ExtensionTransferRegistry, ExtensionTransferError, exportExtensionTransfer, importExtensionTransfer, extensionTransferRequest } from './transfer.js';
export type { ExtensionTransferDescriptor, ExtensionTransferEnvelope, ExtensionTransferCodec, PreparedExtensionTransfer, TransferMark } from './transfer.js';
