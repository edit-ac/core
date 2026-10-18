import type { EngineHandle, StableRange, FragmentBlock, CommitResult, Checkpoint } from '@edit-ac/core';
export type Format = 'rtf' | 'csv' | 'tsv' | 'docx' | 'odt' | 'epub' | 'pdf';
export interface Options {
  format: Format; source?: Uint8Array; filename?: string; mediaType?: string; range?: StableRange; selected?: string;
  /** Mandatory for CSV/TSV. */ newline?: 'lf' | 'crlf';
  /** Mandatory on CSV/TSV import; does not infer types. */ header?: boolean;
  /** Caller-authorized original bytes (for example AssetSession.retainedSource).
   * Captured immutably with the checkpoint; aggregate maximum 1 MiB. */
  /** Exact content hash and explicit host identity/grant; never inferred from a document locator. */
  importGrants?: readonly {sha256:readonly number[];identity:{host:string;key:string};actions:readonly ('ingest'|'read'|'cancel'|'release-reference')[]}[];
  originalAssets?: readonly {identity:{host:string;key:string};actions:readonly 'read'[];bytes:Uint8Array}[];
  safe?: boolean; approveLoss?: boolean; signal?: AbortSignal; timeoutMs?: number;
}
export interface Result {
  profile: string; recovery:Checkpoint; original: Uint8Array; revision: number; capturedRevision: number[];
  inputSha256: number[]; diagnostics: readonly Record<string, unknown>[];
  metrics: { totalPrepareMs:number; bootstrapMs:number; sessionConversionMs:number; wasmLinearBytes:number; wasmMaximumBytes:number; heapBytes:number|null };
}
/** Media remains a candidate until the real shared storage owner stages/adopts it. */
export interface PreparedImport extends Result { blocks: readonly FragmentBlock[]; sessionCommitted: boolean; commit(): CommitResult;
  commitAssets(owner: import('@edit-ac/web').EditorStorageOwner, job:string, host:import('@edit-ac/web/assets').AssetHostTransport, sourceGrant:import('@edit-ac/core').AssetGrant):Promise<import('@edit-ac/web/assets').PreparedAssetCommitReceipt>;
}
export interface ExportResult extends Result { bytes: Uint8Array }
export class FormatError extends Error { code:string; report:Record<string,unknown>; original:Uint8Array; recovery?:Checkpoint }
export function createFormatClient(): {
  prepareImport(engine:EngineHandle, options:Options & {range:StableRange;source:Uint8Array}):Promise<PreparedImport>;
  export(engine:EngineHandle, options:Options):Promise<ExportResult>;
  cancel():void; dispose():void;
};
