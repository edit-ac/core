import { type Checkpoint, type ReplayUpdate, type DocumentIdentity, type CreateOptions, type EngineHandle } from "./engine.js";
export type { CreateOptions, EngineHandle, CommitResult, AnchorToken, PortableAnchor, PlanToken, Bias, StableRange, ContainerStyle, MoveTarget, EditorCommand, EditorPosition, TextCommand, FormatAction, MarkCommand, BlockFormatCommand, PrepareRequest, Json, ProjectedNode, Snapshot, AnchorResolution, HistoryRequest, HistoryState, DocumentIdentity, Checkpoint, ReplayUpdate, PatchScope, Patch, PatchSubscription, ObserverError } from "./engine.js";
export type { FragmentBlock, FragmentRun, PreparedMarkdown, MarkdownDiagnostic, MarkdownExport, MarkdownExtension, MarkdownOptions, MarkdownCodec } from "./engine.js";
export { EngineError } from "./engine.js";
export type { EngineErrorCode } from "./engine.js";
export interface EngineRuntime {
    createEngine(options: CreateOptions): EngineHandle;
    restoreEngine(expected: DocumentIdentity, checkpoint: Checkpoint, journal?: readonly ReplayUpdate[]): EngineHandle;
}
/**
 * Load the compiled semantic engine production runtime explicitly. Import alone performs no I/O,
 * touches no browser globals and creates no document. One URL per module instance;
 * concurrent calls share initialization and failed initialization can be retried.
 */
export declare function init(assetUrl: string): Promise<EngineRuntime>;
export * from "./links/index.js";
