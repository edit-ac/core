import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import * as Y from 'yjs';
import type { Recipe, Action, Expected } from './fixture-loader.ts';
import { assertCheckpoint } from './driver.ts';
import { BrowserEditingDriver } from './browser-driver.ts';

export const lifetimeCapabilities = new Set(['async-anchors', 'remote-delete', 'session-isolation']);
/** Prepared provider/remote-delivery profile. The host explicitly recovers a
 * deleted DOM selection to the first surviving owner; pending clipboard work
 * retains its original anchors and can never use that replacement selection. */
export class BrowserLifetimeDriver {
  readonly snapshots: BrowserEditingDriver;
  readonly requests = new Set<string>();
  readonly page: Page;
  constructor(page: Page) { this.page=page; this.snapshots = new BrowserEditingDriver(page); }
  async mount(recipe: Recipe) {
    for (const capability of recipe.requires) if (!lifetimeCapabilities.has(capability)) throw Error(`Unsupported lifetime capability: ${capability}`);
    const { initial } = recipe;
    if (initial.blocks.length !== 2 || initial.blocks.some(b => b.kind !== 'paragraph' || b.marks.length || b.hardBreaks.length) || initial.pendingMarks !== null)
      throw Error('Unsupported lifetime profile: two unmarked paragraphs');
    await this.page.waitForFunction(() => !!(window as any).inputFixture);
    const ids = await this.page.evaluate(async texts => {
      const f = (window as any).inputFixture; await f.mount(texts[0], texts[1]); return f.ids as string[];
    }, initial.blocks.map(b => b.text));
    initial.blocks.forEach((b, i) => this.snapshots.ids.set(b.id, ids[i]));
    await this.snapshots.select(initial.selection);
    assert.deepEqual((await this.snapshots.observe()).state, initial);
  }
  async step(action: Action, expected: Expected) {
    const before = (await this.snapshots.observe()).observed;
    const frozen = await this.page.evaluate(() => { const e=(window as any).inputFixture.engine; return {revision:e.read().revision,vector:[...e.stateVector()],checkpoint:[...e.checkpoint().bytes],history:e.history({type:'state'})}; });
    let outcome: string;
    if (action.type === 'beginPaste') {
      const request = String(action.request);
      assert.ok(!this.requests.has(request), 'request IDs are unique');
      this.requests.add(request);
      await this.page.evaluate(({ request, text }) => {
        const w = window as any, f = w.inputFixture;
        w.lifetimeJobs ??= {};
        const job: any = { text, target: f.selection.retain() }; w.lifetimeJobs[request] = job;
        job.result = f.protocol.clipboard.pastePlainText(() => new Promise(resolve => { job.resolve = resolve; }), job.target);
      }, { request, text: action.text });
      await this.page.waitForFunction(request => typeof (window as any).lifetimeJobs[request]?.resolve === 'function', request);
      outcome = 'staged';
    } else if (action.type === 'remoteDeleteBlock') {
      const owner = this.snapshots.id(String(action.block));
      const state = await this.page.evaluate(() => { const e = (window as any).inputFixture.engine; return { bytes: [...e.encodeUpdate().bytes], vector: [...e.stateVector()] }; });
      const peer = new Y.Doc(); peer.clientID = 1919;
      try {
        Y.applyUpdate(peer, new Uint8Array(state.bytes));
        peer.getMap('delete-probe-tombstones').set(owner, true);
        await this.page.evaluate(bytes => (window as any).inputFixture.apply(bytes), [...Y.encodeStateAsUpdate(peer, new Uint8Array(state.vector))]);
      } finally { peer.destroy(); }
      await this.page.evaluate(() => { const f = (window as any).inputFixture; f.select(f.engine.read().visible.find((n: any) => n.kind === 'block').id, 0); });
      outcome = 'applied';
    } else if (action.type === 'completePaste') {
      const request = String(action.request); assert.ok(this.requests.has(request), 'completion owns an active request');
      const completed = await this.page.evaluate(async request => {
        const job = (window as any).lifetimeJobs[request]; job.resolve(job.text); const result = await job.result;
        return { result, active: job.target.active };
      }, request);
      this.requests.delete(request); assert.equal(completed.active, false, 'terminal clipboard request releases both anchors');
      outcome = completed.result.disposition;
    } else throw Error(`Unsupported lifetime action: ${action.type}`);
    const snapshot = await this.snapshots.observe(), after = snapshot.observed;
    const local = (s: any) => s.patches.filter((p: any) => p.update && p.origin.startsWith('editac:local:')).length;
    const remote = (s: any) => s.patches.filter((p: any) => p.update && !p.origin.startsWith('editac:local:')).length;
    const result = { state: snapshot.state, outcome, effects: { localCommits: local(after) - local(before), remoteCommits: remote(after) - remote(before) }, revision: after.patches.at(-1)?.revision ?? 0 };
    assertCheckpoint(result, expected);
    assert.equal(after.journal.length - before.journal.length, result.effects.localCommits + result.effects.remoteCommits, 'actual durable journal delta');
    if (outcome === 'rejected' || outcome === 'staged') {
      const current = await this.page.evaluate(() => { const e=(window as any).inputFixture.engine; return {revision:e.read().revision,vector:[...e.stateVector()],checkpoint:[...e.checkpoint().bytes],history:e.history({type:'state'})}; });
      assert.deepEqual(current,frozen,'staging/rejection preserves revision, state vector, checkpoint and history');
      assert.deepEqual(after.text, before.text); assert.deepEqual(after.history, before.history);
    }
    return { result, ...snapshot };
  }
  async replay(recipe: Recipe) {
    await this.mount(recipe); const results = [];
    for (const step of recipe.steps) results.push({ id: step.id, ...await this.step(step.action, step.expect) });
    assert.equal(this.requests.size, 0, 'all owned recipe requests terminal');
    return results;
  }
}
