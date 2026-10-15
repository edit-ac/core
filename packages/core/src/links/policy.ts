/** Host configuration records matching the owning Rust resolver/cache limits.
 * These records configure adapters; they neither implement a cache nor grant IO. */
export interface PublicLinkCachePolicy {
  concurrency: number; queue: number; pending: number; cacheEntries: number;
  positiveMs: number; negativeMs: number; queueMs: number;
}
export interface PrivateLinkCachePolicy { entries: number; offlineLeaseMs: number }
export const DEFAULT_PUBLIC_LINK_CACHE_POLICY: Readonly<PublicLinkCachePolicy> = /* @__PURE__ */ Object.freeze({
  concurrency: 4, queue: 32, pending: 128, cacheEntries: 64,
  positiveMs: 300_000, negativeMs: 5_000, queueMs: 5_000,
});
export const DEFAULT_PRIVATE_LINK_CACHE_POLICY: Readonly<PrivateLinkCachePolicy> = /* @__PURE__ */ Object.freeze({ entries: 64, offlineLeaseMs: 0 });
const between = (n: number, min: number, max: number): boolean => Number.isSafeInteger(n) && n >= min && n <= max;
export function validPublicLinkCachePolicy(p: Readonly<PublicLinkCachePolicy>): boolean {
  return !!p && between(p.concurrency, 1, 8) && between(p.queue, 1, 256) && between(p.pending, 1, 1024)
    && between(p.cacheEntries, 1, 256) && between(p.positiveMs, 1, 3_600_000)
    && between(p.negativeMs, 1, 60_000) && between(p.queueMs, 1, 30_000);
}
export function validPrivateLinkCachePolicy(p: Readonly<PrivateLinkCachePolicy>): boolean {
  return !!p && between(p.entries, 1, 256) && between(p.offlineLeaseMs, 0, 300_000);
}
