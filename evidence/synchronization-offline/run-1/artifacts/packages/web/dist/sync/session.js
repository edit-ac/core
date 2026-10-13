import { DirectSyncAdapter } from "./protocol.js";
export class SyncSessionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "SyncSessionError";
    }
}
const localOrigin = (origin) => origin.startsWith("editac:local:") || origin.startsWith("local:")
    || origin === "history:undo" || origin === "history:redo";
/** Internal host-driven session. No engine recreation, timers, storage writes or
 * receipt claims. Call localCommitted only after the journal transaction commits.
 * Outbox pages bound replay memory independently of the persisted backlog.
 * Remote/restore/replay journal entries never become outbound update messages. */
export class SyncSession {
    engine;
    outbox;
    transport = null;
    adapter = null;
    generation = 0;
    disposed = false;
    incoming = [];
    outgoing = [];
    incomingBytes = 0;
    outgoingBytes = 0;
    replay = null;
    replayIndex = 0;
    cursor = null;
    replayDone = false;
    replayDirty = true;
    retries = 0;
    retryAt = null;
    running = null;
    phase = "detached";
    failure = null;
    limits;
    constructor(engine, outbox, options = {}) {
        this.engine = engine;
        this.outbox = outbox;
        this.limits = { maxFrameBytes: 16 * 1024 * 1024, maxQueuedFrames: 32, maxQueuedBytes: 32 * 1024 * 1024,
            maxWorkPerPump: 32, retryBaseMs: 100, retryMaxMs: 10_000, maxRetries: 8, ...options };
        for (const value of Object.values(this.limits))
            if (!Number.isSafeInteger(value) || value <= 0)
                throw new RangeError("Invalid session limit");
        if (this.limits.maxFrameBytes < 3 || this.limits.maxFrameBytes > 16 * 1024 * 1024
            || this.limits.maxQueuedBytes < this.limits.maxFrameBytes || this.limits.retryMaxMs < this.limits.retryBaseMs)
            throw new RangeError("Inconsistent session limits");
    }
    get state() {
        return { phase: this.phase, error: this.failure, incomingFrames: this.incoming.length,
            outgoingFrames: this.outgoing.length, incomingBytes: this.incomingBytes, outgoingBytes: this.outgoingBytes,
            retryAt: this.retryAt, retries: this.retries, replayPending: this.replayDirty || !this.replayDone || this.replay !== null };
    }
    alive() { if (this.disposed)
        throw new SyncSessionError("disposed", "Session disposed"); }
    /** Each attachment is a new explicitly authorized connection and replay pass. */
    attach(transport, peerIdentity, authorized) {
        this.alive();
        // Validate metadata before changing the existing connection or queues.
        const adapter = new DirectSyncAdapter(this.engine, peerIdentity, { maxFrameBytes: this.limits.maxFrameBytes });
        const handshake = adapter.step1();
        if (!transport || typeof transport.send !== "function")
            throw new TypeError("Transport send required");
        this.detach();
        if (authorized !== true) {
            this.phase = "unauthorized";
            return;
        }
        this.adapter = adapter;
        this.transport = transport;
        this.phase = "attached";
        this.enqueue(handshake);
    }
    detach() {
        this.alive();
        this.generation++;
        this.transport = null;
        this.adapter = null;
        this.incoming = [];
        this.outgoing = [];
        this.incomingBytes = this.outgoingBytes = 0;
        this.replay = null;
        this.replayIndex = 0;
        this.replayDirty = true;
        this.cursor = null;
        this.replayDone = false;
        this.retryAt = null;
        this.retries = 0;
        this.failure = null;
        this.phase = "detached";
    }
    dispose() { if (this.disposed)
        return; this.detach(); this.disposed = true; this.phase = "disposed"; }
    localCommitted(origin) {
        this.alive();
        if (localOrigin(origin))
            this.replayDirty = true;
    }
    /** Admission copies bytes. Overflow ends this connection so its handshake can
     * recover missing remote frames; local bytes remain in the durable outbox. */
    receive(frame) {
        this.alive();
        if (!this.transport)
            throw new SyncSessionError(this.phase === "unauthorized" ? "unauthorized" : "detached", "No authorized transport");
        if (!(frame instanceof Uint8Array) || !frame.length)
            throw new TypeError("Nonempty binary frame required");
        if (frame.length > this.limits.maxFrameBytes || this.incoming.length >= this.limits.maxQueuedFrames
            || this.incomingBytes + frame.length > this.limits.maxQueuedBytes) {
            const error = new SyncSessionError("queue-limit", "Receive queue/frame limit exceeded");
            this.stop(error);
            throw error;
        }
        this.incoming.push(new Uint8Array(frame));
        this.incomingBytes += frame.length;
    }
    enqueue(frame) {
        if (this.outgoing.length >= this.limits.maxQueuedFrames || this.outgoingBytes + frame.length > this.limits.maxQueuedBytes) {
            throw new SyncSessionError("queue-limit", "Send queue limit exceeded");
        }
        this.outgoing.push(frame);
        this.outgoingBytes += frame.length;
    }
    stop(error) { this.detach(); this.phase = "error"; this.failure = error; }
    /** Drive on socket events, completed local commits and the reported retryAt
     * deadline. Bounded work per invocation; idle sessions schedule nothing.
     * Concurrent pumps share one operation; attachment generations fence awaits. */
    pump(now) {
        this.alive();
        if (!Number.isSafeInteger(now) || now < 0)
            throw new RangeError("Monotonic millisecond time required");
        if (this.running)
            return this.running;
        const generation = this.generation;
        this.running = this.run(now, generation).finally(() => { this.running = null; });
        return this.running;
    }
    async run(now, generation) {
        try {
            for (let work = 0; work < this.limits.maxWorkPerPump; work++) {
                if (generation !== this.generation || !this.transport || !this.adapter)
                    return;
                if (this.retryAt !== null && now < this.retryAt)
                    return;
                if (this.outgoing.length) {
                    // A refusing transport must not be allowed to mutate the retained retry.
                    const accepted = this.transport.send(new Uint8Array(this.outgoing[0]));
                    // The host may detach/replace this connection synchronously in send.
                    if (generation !== this.generation)
                        return;
                    if (!accepted) {
                        if (++this.retries > this.limits.maxRetries)
                            throw new SyncSessionError("retry-exhausted", "Explicit reconnect required after bounded retries");
                        this.retryAt = now + Math.min(this.limits.retryMaxMs, this.limits.retryBaseMs * 2 ** (this.retries - 1));
                        return;
                    }
                    this.outgoingBytes -= this.outgoing.shift().length;
                    this.retries = 0;
                    this.retryAt = null;
                }
                else if (this.incoming.length) {
                    const frame = this.incoming.shift();
                    this.incomingBytes -= frame.length;
                    const result = this.adapter.receive(frame);
                    if (result.reply)
                        this.enqueue(result.reply);
                }
                else {
                    if (!this.replay && (this.replayDirty || !this.replayDone)) {
                        if (this.replayDone || this.cursor === null) {
                            this.cursor = null;
                            this.replayDone = false;
                            this.replayDirty = false;
                        }
                        const page = await this.outbox.pendingPage({ ...this.adapter.identity }, this.cursor, this.limits.maxQueuedFrames, this.limits.maxQueuedBytes);
                        if (generation !== this.generation)
                            return;
                        this.replay = page.entries;
                        this.replayIndex = 0;
                        this.cursor = page.after;
                        this.replayDone = page.done;
                    }
                    if (!this.replay)
                        return;
                    const entry = this.replay[this.replayIndex++];
                    if (!entry) {
                        this.replay = null;
                        this.replayIndex = 0;
                        continue;
                    }
                    if (localOrigin(entry.origin))
                        this.enqueue(this.adapter.update({ identity: entry.identity, bytes: entry.bytes }));
                }
            }
        }
        catch (error) {
            if (generation === this.generation)
                this.stop(error);
            throw error;
        }
    }
}
