/** Host configuration records matching the owning Rust resolver/cache limits.
 * These records configure adapters; they neither implement a cache nor grant IO. */
export interface PublicLinkCachePolicy {
    concurrency: number;
    queue: number;
    pending: number;
    cacheEntries: number;
    positiveMs: number;
    negativeMs: number;
    queueMs: number;
}
export interface PrivateLinkCachePolicy {
    entries: number;
    offlineLeaseMs: number;
}
export declare const DEFAULT_PUBLIC_LINK_CACHE_POLICY: Readonly<PublicLinkCachePolicy>;
export declare const DEFAULT_PRIVATE_LINK_CACHE_POLICY: Readonly<PrivateLinkCachePolicy>;
export declare function validPublicLinkCachePolicy(p: Readonly<PublicLinkCachePolicy>): boolean;
export declare function validPrivateLinkCachePolicy(p: Readonly<PrivateLinkCachePolicy>): boolean;
