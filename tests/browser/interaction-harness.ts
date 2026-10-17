import assert from 'node:assert/strict';
import { BrowserEditingDriver } from '../editing/browser-driver.ts';
import { assertCheckpoint } from '../editing/driver.ts';
import type { Expected, State } from '../editing/fixture-loader.ts';

/** RGS owns engine/adapter execution. This layer adds interaction oracles only. */
export class InteractionHarness extends BrowserEditingDriver {
  async requireEngine() {
    assert.equal(await this.page.evaluate(() => {
      const engine = (window as any).inputFixture?.engine;
      return !!engine && typeof engine.read === 'function' &&
        typeof engine.prepare === 'function' && typeof engine.commit === 'function' &&
        engine.checkpoint().bytes.byteLength > 0;
    }), true, 'interaction harness requires a mounted real engine');
  }
  async mount(initial: State) {
    await super.mount(initial);
    await this.requireEngine();
  }
  async checkpoint(expected: Expected, totals: { local: number; remote: number; undo: number }) {
    await this.requireEngine();
    const snapshot = await this.observe();
    const local = snapshot.observed.patches.filter((p: any) => p.update && p.origin.startsWith('editac:local:')).length;
    const remote = snapshot.observed.patches.filter((p: any) => p.update && !p.origin.startsWith('editac:local:')).length;
    assertCheckpoint({ outcome: 'applied', state: snapshot.state,
      effects: { localCommits: local, remoteCommits: remote }, revision: 0 }, expected);
    assert.deepEqual({ local, remote, undo: snapshot.observed.history.undoGroups }, totals,
      'actual committed updates and semantic history');
    assert.equal(snapshot.observed.journal.length, local + remote, 'durable update count');
    return snapshot;
  }
}
