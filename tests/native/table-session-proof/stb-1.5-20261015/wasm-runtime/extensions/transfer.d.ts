import type { DocumentIdentity, EngineHandle, FragmentBlock, Json, PrepareRequest, StableRange } from '../engine.js';
export declare const EXTENSION_TRANSFER_VERSION: 1;
export declare const EXTENSION_TRANSFER_MIME = "application/x-edit-ac-extension+json";
export type TransferMark = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link';
/** Data declaration; this does not admit new document schema or editing semantics. */
export interface ExtensionTransferDescriptor {
    readonly type: string;
    readonly versions: readonly number[];
    readonly inline: readonly TransferMark[];
    readonly blocks: readonly ('paragraph' | 'heading' | 'code' | 'content')[];
    readonly tableMetadata: readonly ('rows' | 'columns' | 'alignment' | 'header' | 'spans' | 'cell-paragraph-style')[];
    readonly fallback: 'inert-source-with-recovery';
}
export interface ExtensionTransferEnvelope {
    readonly version: 1;
    readonly type: string;
    readonly dataVersion: number;
    readonly source: string;
    readonly payload: Json;
}
/** Trusted host code, separate from the serialized descriptor and document. */
export interface ExtensionTransferCodec {
    prepare(envelope: ExtensionTransferEnvelope): readonly FragmentBlock[];
}
export interface PreparedExtensionTransfer {
    readonly version: 1;
    readonly identity: DocumentIdentity;
    readonly revision: number;
    readonly mode: 'formatted' | 'literal' | 'fallback';
    readonly blocks: readonly FragmentBlock[];
    readonly recovery: ExtensionTransferEnvelope;
    readonly diagnostics: readonly string[];
}
export declare class ExtensionTransferError extends Error {
    readonly code: 'invalid-data' | 'resource-limit' | 'invalid-descriptor' | 'duplicate' | 'codec-failed' | 'undeclared-formatting' | 'stale-target';
    constructor(code: 'invalid-data' | 'resource-limit' | 'invalid-descriptor' | 'duplicate' | 'codec-failed' | 'undeclared-formatting' | 'stale-target');
}
export declare function exportExtensionTransfer(value: ExtensionTransferEnvelope): string;
export declare function importExtensionTransfer(raw: string): ExtensionTransferEnvelope;
export declare class ExtensionTransferRegistry {
    #private;
    /** Validate the whole set before activation; caller declarations remain mutable. */
    constructor(entries: readonly {
        descriptor: ExtensionTransferDescriptor;
        codec?: ExtensionTransferCodec;
    }[]);
    descriptors(): readonly ExtensionTransferDescriptor[];
    prepare(engine: EngineHandle, input: ExtensionTransferEnvelope, literal?: boolean): PreparedExtensionTransfer;
}
/** Shared host capability/commit boundary remains responsible for atomic admission,
 * history, storage and permission. Stable range tokens remain caller-owned. */
export declare function extensionTransferRequest(prepared: PreparedExtensionTransfer, engine: EngineHandle, range: StableRange, origin: string, cut?: boolean): PrepareRequest;
