export const DEFAULT_PUBLIC_LINK_CACHE_POLICY = /* @__PURE__ */ Object.freeze({
    concurrency: 4, queue: 32, pending: 128, cacheEntries: 64,
    positiveMs: 300_000, negativeMs: 5_000, queueMs: 5_000,
});
export const DEFAULT_PRIVATE_LINK_CACHE_POLICY = /* @__PURE__ */ Object.freeze({ entries: 64, offlineLeaseMs: 0 });
const between = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
export function validPublicLinkCachePolicy(p) {
    return !!p && between(p.concurrency, 1, 8) && between(p.queue, 1, 256) && between(p.pending, 1, 1024)
        && between(p.cacheEntries, 1, 256) && between(p.positiveMs, 1, 3_600_000)
        && between(p.negativeMs, 1, 60_000) && between(p.queueMs, 1, 30_000);
}
export function validPrivateLinkCachePolicy(p) {
    return !!p && between(p.entries, 1, 256) && between(p.offlineLeaseMs, 0, 300_000);
}
