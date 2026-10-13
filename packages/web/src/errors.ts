/** Preserve the existing public diagnostic conversion for adapter failures. */
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
