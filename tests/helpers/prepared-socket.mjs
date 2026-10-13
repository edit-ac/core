/** Test-only binary socket pair. Explicit delivery replaces all network and timers.
 * It models copied frames and disconnects, not authorization or durable storage.
 */
export function preparedSocketPair({ maxFrameBytes = 16 * 1024 * 1024, maxQueuedFrames = 32 } = {}) {
  for (const value of [maxFrameBytes, maxQueuedFrames]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Invalid fixture bound');
  }
  const queues = [[], []];
  let connected = true, closed = false;
  function requireConnected() {
    if (closed) throw new Error('Prepared socket closed');
    if (!connected) throw new Error('Prepared socket disconnected');
  }
  const endpoints = [0, 1].map(index => ({
    send(bytes) {
      requireConnected();
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Binary frame required');
      if (!bytes.byteLength || bytes.byteLength > maxFrameBytes) throw new RangeError('Frame bound exceeded');
      const destination = queues[1 - index];
      if (destination.length >= maxQueuedFrames) throw new RangeError('Queue bound exceeded');
      destination.push(new Uint8Array(bytes));
    },
    get pending() { return queues[index].length; },
    receive(position = 0) {
      requireConnected();
      if (!Number.isSafeInteger(position) || position < 0 || position >= queues[index].length) {
        throw new RangeError('No prepared frame at position');
      }
      return queues[index].splice(position, 1)[0];
    },
  }));
  return {
    client: endpoints[0], peer: endpoints[1],
    disconnect() { if (closed) throw new Error('Prepared socket closed'); connected = false; },
    reconnect() { if (closed) throw new Error('Prepared socket closed'); connected = true; },
    close() { closed = true; connected = false; queues.forEach(queue => { queue.length = 0; }); },
    get closed() { return closed; },
  };
}
