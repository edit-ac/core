import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/** Prepared process transport over the existing serialized SQLite/EditService
 * owner. y-protocols framing only; mutation and durable admission stay in Rust. */
export async function hostOwner(directory) {
  await mkdir(directory, { recursive: true });
  const executable = resolve('target/debug/examples/host-realtime-owner');
  const child = spawn(executable, [join(directory, 'host.sqlite3')], { stdio: ['pipe','pipe','pipe'] });
  const exited = once(child, 'exit'), waiting = [], transcript = [];
  let queue = Promise.resolve(), stderr = '', ended = false;
  child.stderr.on('data', b => { stderr += b; });
  createInterface({ input: child.stdout }).on('line', line => waiting.shift()?.(JSON.parse(line)));
  const rpc = input => {
    const result = queue.then(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Host RPC timeout: ${input.op}`)), 8000);
      waiting.push(value => { clearTimeout(timer); resolve(value); });
      child.stdin.write(JSON.stringify(input) + '\n');
    }));
    queue = result.then(output => { transcript.push({ input, output }); }, () => {});
    return result;
  };
  async function frame(bytes, writerId) {
    const decoder = decoding.createDecoder(new Uint8Array(bytes));
    const type = decoding.readVarUint(decoder), payload = decoding.readVarUint8Array(decoder);
    assert.equal(decoding.hasContent(decoder), false); assert.ok(type >= 0 && type <= 2);
    if (type === 0) {
      const result = await rpc({ op: 'sync', vector: [...payload] });
      assert.equal(result.error, undefined); const out = encoding.createEncoder();
      encoding.writeVarUint(out, 1); encoding.writeVarUint8Array(out, new Uint8Array(result.ok.bytes));
      return [...encoding.toUint8Array(out)];
    }
    const result = await rpc({ op: 'peer', writerId, bytes: [...payload] });
    assert.equal(result.error, undefined); return null;
  }
  return { rpc, frame, facts: { pid: child.pid, executable, directory, transport: 'prepared JSON + y-protocols 1.0.7 frames', store: 'actual Rust Session/SQLite' },
    async close() {
      if (ended) return; ended = true; await queue; child.stdin.end();
      const [code, signal] = await exited;
      await writeFile(join(directory, 'transport.json'), JSON.stringify(transcript, null, 2));
      await writeFile(join(directory, 'stderr.log'), stderr);
      assert.equal(code, 0, stderr); assert.equal(signal, null); return { code, signal };
    } };
}
