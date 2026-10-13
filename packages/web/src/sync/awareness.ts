import type { AnchorResolution, AnchorToken, EngineHandle, PortableAnchor, StableRange } from '@edit-ac/core';

/** Pinned y-protocols 1.0.7 awareness payload (no provider/room envelope). */
export const awarenessProtocolVersion = 'y-protocols/1.0.7';
type State = { selection: { anchor: PortableAnchor; focus: PortableAnchor } | null };
type Peer = { clock: number; updated: number; selection: StableRange | null; present: boolean };
export interface AwarenessOptions { maxPeers?: number; maxFrameBytes?: number; throttleMs?: number; expiryMs?: number }
export interface PeerPresence { clientId: number; selection: { anchor: AnchorResolution; focus: AnchorResolution } | null }
export class AwarenessError extends Error {
  constructor(readonly code: 'invalid-frame' | 'resource-limit' | 'invalid-cursor' | 'disposed', message: string) {
    super(message); this.name = 'AwarenessError';
  }
}
function fail(code: AwarenessError['code'], message: string): never { throw new AwarenessError(code, message); }
function uint(n: number): boolean { return Number.isInteger(n) && n >= 0 && n <= 0xffffffff; }
function write(n: number, out: number[]): void {
  do { const digit = n % 128; n = Math.floor(n / 128); out.push(digit | (n ? 128 : 0)); } while (n);
}
function read(bytes: Uint8Array, cursor: { offset: number }): number {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const b = bytes[cursor.offset++];
    if (b === undefined) fail('invalid-frame', 'Truncated varuint');
    n += (b & 127) * 2 ** (7 * i);
    if (n > 0xffffffff) fail('invalid-frame', 'Varuint overflow');
    if (b < 128) { if (i && b === 0) fail('invalid-frame', 'Noncanonical varuint'); return n; }
  }
  return fail('invalid-frame', 'Varuint overflow');
}
function plain(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function anchor(value: unknown): value is PortableAnchor {
  if (!plain(value, ['version', 'identity', 'source', 'sourceIdentity', 'position']) || value.version !== 1
    || typeof value.source !== 'string' || value.source.length > 128
    || typeof value.sourceIdentity !== 'string' || value.sourceIdentity.length > 128) return false;
  const p = value.position;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const r = p as Record<string, unknown>, scopes = ['item', 'type', 'tname'].filter(k => Object.hasOwn(r, k));
  // JS includes the owning type as well as an item; Yrs serializes only the
  // authoritative item. Never permit contradictory owning type/root metadata.
  if (!scopes.length || (scopes.includes('type') && scopes.includes('tname'))
    || !plain(r, [...scopes, 'assoc']) || (r.assoc !== -1 && r.assoc !== 0)) return false;
  return scopes.every(scope => {
    const target = r[scope];
    return scope === 'tname' ? typeof target === 'string' && target.length <= 128
      : plain(target, ['client', 'clock']) && uint(target.client as number) && uint(target.clock as number);
  });
}
function canonical(value: PortableAnchor): PortableAnchor {
  const p = value.position as Record<string, PortableAnchor['position']>;
  const scope = Object.hasOwn(p, 'item') ? 'item' : Object.hasOwn(p, 'type') ? 'type' : 'tname';
  return { ...value, position: { [scope]: p[scope]!, assoc: p.assoc! } };

}
function state(value: unknown): value is State | null {
  if (value === null) return true;
  if (!plain(value, ['selection'])) return false;
  const s = value.selection;
  return s === null || (plain(s, ['anchor', 'focus']) && anchor(s.anchor) && anchor(s.focus));
}
function frame(clientId: number, clock: number, value: State | null): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(value)), bytes: number[] = [];
  write(1, bytes); write(clientId, bytes); write(clock, bytes); write(json.length, bytes);
  const result = new Uint8Array(bytes.length + json.length); result.set(bytes); result.set(json, bytes.length); return result;
}

/** Optional, host-driven ephemeral presence. Never subscribes to document updates,
 * opens storage, creates a Y.Doc, schedules timers or makes durability claims.
 * Host authenticates peers and routes awareness separately from baseline sync.
 * Retained expiry tombstones prevent duplicate frames resurrecting stale peers;
 * maxPeers bounds both live peers and tombstones for the lifetime of this adapter.
 */
export class AwarenessAdapter {
  private readonly maxPeers: number;
  private readonly maxFrameBytes: number;
  private readonly throttleMs: number;
  private readonly expiryMs: number;
  private readonly remote = new Map<number, Peer>();
  private local: State | null = null;
  private clock = 0;
  private dirty = false;
  private lastAttempt = -Infinity;
  private lastSent = -Infinity;
  private time = 0;
  private disposed = false;
  constructor(private readonly engine: Pick<EngineHandle, 'exportAnchor' | 'importAnchor' | 'resolve' | 'releaseAnchor'>,
    readonly clientId: number, options: AwarenessOptions = {}) {
    this.maxPeers = options.maxPeers ?? 64; this.maxFrameBytes = options.maxFrameBytes ?? 64 * 1024;
    this.throttleMs = options.throttleMs ?? 50; this.expiryMs = options.expiryMs ?? 30_000;
    if (!uint(clientId) || !Number.isInteger(this.maxPeers) || this.maxPeers < 1 || this.maxPeers > 1024
      || !Number.isInteger(this.maxFrameBytes) || this.maxFrameBytes < 16 || this.maxFrameBytes > 64 * 1024
      || !Number.isFinite(this.throttleMs) || this.throttleMs < 1
      || !Number.isFinite(this.expiryMs) || this.expiryMs < this.throttleMs * 4) fail('resource-limit', 'Invalid awareness limits');
  }
  private alive(): void { if (this.disposed) fail('disposed', 'Awareness is disposed'); }
  private now(now: number): void {
    this.alive();
    if (!Number.isFinite(now) || now < this.time) fail('invalid-frame', 'Monotonic host time required');
    this.time = now;
  }
  private release(selection: StableRange | null): void {
    if (selection) { this.engine.releaseAnchor(selection.anchor); this.engine.releaseAnchor(selection.focus); }
  }
  private advance(): void {
    if (this.clock === 0xffffffff) fail('resource-limit', 'Awareness clock exhausted');
    this.clock++; this.dirty = true;
  }
  /** Online with an optional cursor. Export now; later delivery retains relative positions. */
  setLocal(selection: StableRange | null): void {
    this.alive();
    const value: State = { selection: selection ? { anchor: this.engine.exportAnchor(selection.anchor), focus: this.engine.exportAnchor(selection.focus) } : null };
    if (frame(this.clientId, Math.min(this.clock + 1, 0xffffffff), value).length > this.maxFrameBytes) fail('resource-limit', 'Local presence exceeds frame limit');
    this.advance(); this.local = value;
  }
  clearLocal(): void { this.alive(); this.advance(); this.local = null; }
  /** At most one copied frame per throttle interval, even after rejection/error.
   * Call while presence is enabled to renew at expiry/2; no idle timer is created. */
  flush(send: (bytes: Uint8Array) => boolean, now: number): boolean {
    this.now(now);
    if (!this.dirty && this.local !== null && now - this.lastSent >= this.expiryMs / 2) this.advance();
    if (!this.dirty || now - this.lastAttempt < this.throttleMs) return false;
    const current = this.clock, bytes = frame(this.clientId, current, this.local);
    if (bytes.length > this.maxFrameBytes) fail('resource-limit', 'Local presence exceeds frame limit');
    this.lastAttempt = now;
    if (!send(bytes)) return false;
    if (!this.disposed && this.clock === current) { this.dirty = false; this.lastSent = now; }
    return true;
  }
  /** Parse/admit the whole bounded payload and all cursors before replacing peers. */
  receive(input: Uint8Array, now: number): void {
    this.now(now);
    if (!(input instanceof Uint8Array) || input.length > this.maxFrameBytes) fail('resource-limit', 'Awareness frame limit');
    const bytes = input.slice(), cursor = { offset: 0 }, count = read(bytes, cursor);
    if (count > this.maxPeers) fail('resource-limit', 'Awareness entry limit');
    const entries: { id: number; clock: number; state: State | null }[] = [], ids = new Set<number>();
    let added = 0;
    for (let i = 0; i < count; i++) {
      const id = read(bytes, cursor), clock = read(bytes, cursor), size = read(bytes, cursor);
      if (ids.has(id) || size > bytes.length - cursor.offset) fail('invalid-frame', 'Duplicate or truncated awareness entry');
      ids.add(id);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor.offset, cursor.offset + size))); }
      catch { fail('invalid-frame', 'Invalid presence JSON/UTF-8'); }
      cursor.offset += size;
      if (!state(value)) fail('invalid-cursor', 'Unsupported presence state/cursor');
      if (id === this.clientId) continue; // peers cannot overwrite/remove this local state
      const known = this.remote.get(id);
      if (!known && clock === 0) continue; // Pinned oracle's unknown-peer clock starts at zero.
      if (known && (clock < known.clock || (clock === known.clock && (value !== null || !known.present)))) continue;
      if (!known) added++;
      entries.push({ id, clock, state: value });
    }
    if (cursor.offset !== bytes.length) fail('invalid-frame', 'Trailing awareness bytes');
    if (this.remote.size + added > this.maxPeers) fail('resource-limit', 'Presence/tombstone capacity');
    const admitted: { id: number; peer: Peer }[] = [];
    try {
      for (const e of entries) {
        let selection: StableRange | null = null;
        if (e.state?.selection) {
          const a = this.engine.importAnchor(canonical(e.state.selection.anchor));
          try { selection = { anchor: a, focus: this.engine.importAnchor(canonical(e.state.selection.focus)) }; }
          catch (error) { this.engine.releaseAnchor(a); throw error; }
        }
        admitted.push({ id: e.id, peer: { clock: e.clock, updated: now, selection, present: e.state !== null } });
      }
    } catch {
      for (const e of admitted) this.release(e.peer.selection);
      fail('invalid-cursor', 'Cursor does not resolve in the current document/epoch');
    }
    for (const e of admitted) { this.release(this.remote.get(e.id)?.selection ?? null); this.remote.set(e.id, e.peer); }
  }
  expire(now: number): number {
    this.now(now); let expired = 0;
    for (const peer of this.remote.values()) if (peer.present && now - peer.updated >= this.expiryMs) {
      this.release(peer.selection); peer.selection = null; peer.present = false; expired++;
    }
    return expired;
  }
  peers(now: number): readonly PeerPresence[] {
    this.expire(now);
    const result: PeerPresence[] = [];
    for (const [clientId, peer] of this.remote) if (peer.present) {
      let selection: PeerPresence['selection'] = null;
      if (peer.selection) {
        try {
          const a = this.engine.resolve(peer.selection.anchor), f = this.engine.resolve(peer.selection.focus);
          if (a.type === 'position' && f.type === 'position') selection = { anchor: a, focus: f };
        } catch { /* Released/disposed/removed targets never redirect to another cursor. */ }
      }
      result.push({ clientId, selection });
    }
    return result;
  }
  dispose(): void {
    if (this.disposed) return;
    for (const peer of this.remote.values()) this.release(peer.selection);
    this.remote.clear(); this.local = null; this.dirty = false; this.disposed = true;
  }
}
