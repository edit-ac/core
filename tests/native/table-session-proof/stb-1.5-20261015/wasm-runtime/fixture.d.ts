import { type Checkpoint, type ReplayUpdate, type DocumentIdentity, type CreateOptions, type EngineHandle } from "./engine.js";
export type { CreateOptions, EngineHandle, CommitResult, AnchorToken, PortableAnchor, PlanToken, Bias, StableRange, ContainerStyle, MoveTarget, EditorCommand, EditorPosition, TextCommand, FormatAction, MarkCommand, BlockFormatCommand, PrepareRequest, Json, ProjectedNode, Snapshot, AnchorResolution, HistoryRequest, HistoryState, DocumentIdentity, Checkpoint, ReplayUpdate, PatchScope, Patch, PatchSubscription, ObserverError } from "./engine.js";
export type { FragmentBlock, FragmentRun, PreparedMarkdown, MarkdownDiagnostic, MarkdownExport, MarkdownExtension, MarkdownOptions } from "./engine.js";
export { EngineError } from "./engine.js";
export type { EngineErrorCode } from "./engine.js";
/** Disposable foundation fixture; callers must release its WASM allocation. */
export interface Fixture {
    text(): string;
    utf16_length(): number;
    update_v1(): Uint8Array;
    apply_v1(bytes: Uint8Array): void;
    free(): void;
}
export interface EngineRuntime {
    createEngine(options: CreateOptions): EngineHandle;
    restoreEngine(expected: DocumentIdentity, checkpoint: Checkpoint, journal?: readonly ReplayUpdate[]): EngineHandle;
}
export interface FixtureRuntime extends EngineRuntime {
    createFixture(): Fixture;
    createdDocumentCount(): number;
}
/**
 * Load the compiled semantic engine and preserved fixture runtime explicitly. Import alone performs no I/O,
 * touches no browser globals and creates no document. One URL per module instance;
 * concurrent calls share initialization and failed initialization can be retried.
 */
export declare function initFixture(assetUrl: string): Promise<FixtureRuntime>;
