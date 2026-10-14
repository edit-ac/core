/** Preserve the existing public diagnostic conversion for adapter failures. */
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Shared command/clipboard rejection shape; preserves public diagnostic reasons. */
export const rejected = (reason: string) => ({ disposition: 'rejected' as const, reason });
