// Harness-only IPC fault control. Never exposed through the HTTP service.
import { startReferenceRelay } from '../../examples/sync-server/relay.mjs';
let relay, paused, mode, stopping = false;
process.on('message', async message => {
  try {
    if (message.type === 'start') {
      mode = message.fault;
      relay = await startReferenceRelay({ ...message.options, fault: async boundary => {
        if (mode?.boundary !== boundary) return;
        const action = mode.action; mode = null;
        if (action === 'throw') throw new Error('Prepared commit failure');
        await new Promise(resolve => { paused = resolve; process.send({ type: 'boundary', boundary }); });
      } });
      process.send({ type: 'ready', pid: process.pid, url: relay.url });
    } else if (message.type === 'arm') { mode = message.fault; process.send({ type: 'armed' }); }
    else if (message.type === 'resume') { const resolve = paused; paused = null; resolve?.(); }
    else if (message.type === 'revoke') { relay.revoke(message.token); process.send({ type: 'revoked' }); }
    else if (message.type === 'stop') await stop();
  } catch (error) { process.send({ type: 'error', error: error.message }); }
});
async function stop() {
  if (stopping) return; stopping = true;
  paused?.(); await relay?.close(); process.disconnect();
}
process.once('SIGTERM', stop);
process.once('disconnect', () => { if (!stopping) void stop(); });
