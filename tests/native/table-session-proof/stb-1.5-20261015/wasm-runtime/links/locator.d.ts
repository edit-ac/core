/** Safe presentation/admission URLs. Imported HTML requires absolute URLs and
 * rejects credentials/encoded controls; stored projections resolve against the host. */
export declare function safeLink(value: unknown, base?: string): string | null;
