/** Version of the public API contract, independent of each descriptor's data version. */
export const EXTENSION_API_VERSION = 1 as const;
export { ModuleRegistry, ModuleContractError } from './registry.js';
export type { ModuleDefinition, ModulePresentation } from './registry.js';
export type { ModuleDefinition as ModuleDefinitionV1 } from './registry.js';
// Aliases preserve the qualified engine and codec boundary; no parallel commands.
export type {
  EditorCommand as ExtensionCommandV1, PrepareRequest, CommitResult,
  EngineHandle, StableRange, FragmentBlock, FragmentRun,
  MarkdownCodec as MarkdownCodecV1, MarkdownExtension as MarkdownExtensionV1,
  MarkdownOptions, PreparedMarkdown, MarkdownExport, PatchSubscription,
} from '../engine.js';

export { prepareModuleMigration, ModuleEvolutionError } from './evolution.js';
export type { ModuleEvolution, PreparedModuleMigration } from './evolution.js';
export { prepareExtensionProfile, ExtensionProfileActivation, ProfileError, FIRST_PARTY_FEATURES, FIRST_PARTY_PROFILES } from './profiles.js';
export type { ProfileFeature, ExtensionProfile, ProfileEnvironment, PreparedProfile, ProfileResource, ProfileLoader } from './profiles.js';
export { EXTENSION_TRANSFER_VERSION, EXTENSION_TRANSFER_MIME, ExtensionTransferRegistry, ExtensionTransferError, exportExtensionTransfer, importExtensionTransfer, extensionTransferRequest } from './transfer.js';
export type { ExtensionTransferDescriptor, ExtensionTransferEnvelope, ExtensionTransferCodec, PreparedExtensionTransfer, TransferMark } from './transfer.js';

export { DocumentSearchSession, DocumentSearchError, DOCUMENT_SEARCH_PROFILE, DOCUMENT_SEARCH_LIMITS } from './search.js';
export type { DocumentSearchMatch, DocumentSearchResult } from './search.js';

export { CODE_COMMAND_PROFILE, CODE_COMMAND_LIMIT, CODE_PAIRS, CodeCommandError, codeContext, codeEdit, commitCodeEdit, executeCodeCommand } from './code.js';
export type { CodeAction, CodeContext, CodeEdit } from './code.js';

export { AI_VERSION, AI_PROFILE, AI_CAPABILITIES, AiHost, AiError } from './ai.js';
export type { AiOperation, AiScope, AiLimits, AiDescriptor, AiTarget, AiRequest, AiErrorCode, AiStatus, AiUsage, AiResponse, AiPolicy, AiTransport } from './ai.js';

export { AiSession, captureAiTarget } from './ai-session.js';
export type { AiSessionStatus, AiReviewTarget } from './ai-session.js';

export { AI_ACTION_PROFILE, AI_ACTIONS, AI_TONES, prepareAiAction } from './ai-actions.js';
export type { AiActionId, AiTone, AiActionOptions, PreparedAiAction } from './ai-actions.js';
