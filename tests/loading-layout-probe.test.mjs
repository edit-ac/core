import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutProbeCss, runLayoutAction, installLayoutProbe } from '../scripts/loading-layout-probe.mjs';
import { inspectLoadings } from '../scripts/loading-evidence.mjs';
import { fixture } from '../benchmarks/fixtures.mjs';
import { captureAXOwners } from '../scripts/loading-ax-coverage.mjs';
test('unknown CSS experiment fails before launching a browser', () => {
  assert.throws(() => layoutProbeCss('hidden'), /Unknown/);
  assert.equal(layoutProbeCss('control'), '');
  assert.match(layoutProbeCss('auto'), /content-visibility:auto/);
});
for (const mode of ['control', 'auto', 'auto-dirty', 'layout']) test(`experimental ${mode} cannot enter canonical loading admission`, () => {
  assert.throws(() => inspectLoadings({}, { metadata: { layoutProbe: `experimental-${mode}-v1` } }), /Experimental layout/);
});
test('removing metadata cannot launder experimental behavior into admission', () => {
  assert.throws(() => inspectLoadings({}, { cases: [{ pairs: [{ warm: { layoutProbe: {} } }] }] }), /Experimental layout/);
});
const nodes = () => fixture('Task').blocks.map(b => ({ nodeId: String(b.runs[0].text), ignored: false, role: { value: 'StaticText' }, name: { value: b.runs[0].text } }));
const editable = { nodeId: 'root', childIds: nodes().map(n => n.nodeId), role: { value: 'textbox' }, backendDOMNodeId: 7, ignored: false, properties: [{ name: 'editable', value: { value: 'richtext' } }] };
const fake = entries => ({ send: async command => command === 'Accessibility.getFullAXTree' ? { nodes: entries } : {} });
const page = { keyboard: { press: async () => {} }, evaluate: async () => true };
test('AX oracle rejects a missing offscreen block even with an editable node', async () => {
  await assert.rejects(runLayoutAction(page, fake([...nodes().slice(0, -1), editable]), 'accessibility', { name: 'Task' }), /Incomplete accessibility tree/);
});
test('AX oracle rejects reversed same-count content', async () => {
  await assert.rejects(runLayoutAction(page, fake([...nodes(), { ...editable, childIds: [...editable.childIds].reverse() }]), 'accessibility', { name: 'Task' }), /coverage differs/);
});
test('AX oracle rejects full text without an actionable editable node', async () => {
  await assert.rejects(runLayoutAction(page, fake(nodes()), 'accessibility', { name: 'Task' }), /coverage differs/);
});
test('AX oracle rejects failed focus and keyboard action', async () => {
  await assert.rejects(runLayoutAction({ ...page, evaluate: async () => false }, fake([...nodes(), editable]), 'accessibility', { name: 'Task' }), /action failed/);
});
test('AX observation returns bounded counts, not content or qualified screen-reader claims', async () => {
  assert.deepEqual(await runLayoutAction(page, fake([...nodes(), editable]), 'accessibility', { name: 'Task' }), { textNodes: 20, expectedBlocks: 20, exactText: true, focusAndKeyboard: true, screenReaderQualified: false });
});

test('AX oracle excludes unrelated status/control text outside the editor subtree', async () => {
  const outside = { nodeId: 'status', ignored: false, role: { value: 'StaticText' }, name: { value: 'Private outside content' } };
  const observation = await runLayoutAction(page, fake([...nodes(), outside, editable]), 'accessibility', { name: 'Task' });
  assert.equal(observation.textNodes, 20);
  assert(!JSON.stringify(observation).includes('Private'));
});

test('retained CSS experiment artifacts prevent metadata/behavior laundering', () => {
  for (const path of ['experiment.css', 'layout-probe-source.mjs', 'ax-coverage-source.mjs'])
    assert.throws(() => inspectLoadings({}, { artifacts: { [path]: 'hash' } }), /Experimental layout/);
});

test('AX oracle follows logical child order rather than protocol inventory order', async () => {
  const observation = await runLayoutAction(page, fake([...nodes().reverse(), editable]), 'accessibility', { name: 'Task' });
  assert.equal(observation.exactText, true);
});

test('staged AX metadata cannot enter canonical admission after removing the layout label', () => {
  assert.throws(() => inspectLoadings({}, { metadata: { axStageProbes: true } }), /Experimental layout/);
});

test('dirty containment materializes changed text and containing lists on every timed pair', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.evaluate(installLayoutProbe, { enabled: false, mode: 'auto-dirty' });
    await page.evaluate(() => {
      document.body.innerHTML = '<div id="editor"><p data-node-id="a">first 😀</p><ul data-node-id="list"><li data-node-id="b">nested</li></ul><p data-node-id="c">untouched</p></div>';
    });
    assert.deepEqual(await page.locator('#editor > *').evaluateAll(els => els.map(e => e.style.contentVisibility)), ['', '', '']);
    await page.evaluate(() => {
      document.querySelector('[data-node-id="a"]').firstChild.replaceData(0, 5, 'changed');
      document.querySelector('[data-node-id="b"]').replaceChildren(document.createTextNode('replacement'));
    });
    assert.deepEqual(await page.locator('#editor > *').evaluateAll(els => els.map(e => e.style.contentVisibility)), ['visible', 'visible', '']);
    await page.evaluate(() => { document.querySelector('[data-node-id="a"]').firstChild.replaceData(0, 7, 'first'); });
    assert.equal(await page.locator('[data-node-id="a"]').textContent(), 'first 😀');
    assert.equal(await page.locator('[data-node-id="a"]').evaluate(e => e.style.contentVisibility), 'visible');
    await page.evaluate(() => {
      const added = document.createElement('p'); added.dataset.nodeId = 'new'; added.textContent = 'new owner';
      document.querySelector('#editor').append(added);
      const replacement = document.createElement('p'); replacement.dataset.nodeId = 'replacement'; replacement.textContent = 'replacement owner';
      document.querySelector('[data-node-id="c"]').replaceWith(replacement);
    });
    assert.deepEqual(await page.locator('[data-node-id="new"], [data-node-id="replacement"]').evaluateAll(els => els.map(e => e.style.contentVisibility)), ['visible', 'visible']);
    await page.evaluate(() => dispatchEvent(new Event('pagehide')));
    await page.evaluate(() => {
      const added = document.createElement('p'); added.dataset.nodeId = 'after'; added.textContent = 'after teardown';
      document.querySelector('#editor').append(added);
    });
    assert.equal(await page.locator('[data-node-id="after"]').evaluate(e => e.style.contentVisibility), '');
  } finally { await browser.close(); }
});

test('non-eliding layout retains initial and changed offscreen owners without materialization', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    await page.setContent(`<style>${layoutProbeCss('layout')}</style><div id="editor" contenteditable role="textbox" style="height:40px;overflow:auto"></div>`);
    await page.evaluate(installLayoutProbe, { enabled: false, mode: 'layout' });
    await page.evaluate(() => {
      document.querySelector('#editor').innerHTML = Array.from({ length: 80 }, (_, i) => `<p data-node-id="p${i}">owner ${i} 😀</p>`).join('') + '<ul data-node-id="list"><li data-node-id="nested">nested owner</li></ul>';
    });
    const observe = async () => {
      const owners = await page.locator('#editor p, #editor li').evaluateAll(els => els.map(e => ({ id: e.dataset.nodeId })));
      const coverage = await captureAXOwners(cdp, owners);
      assert.equal(coverage.logicalBlocks, owners.length);
      assert.deepEqual(coverage.missingIndices, []);
      assert(await page.locator('#editor > *').evaluateAll(els => els.every(e => getComputedStyle(e).contentVisibility === 'visible' && !e.style.contentVisibility)));
      assert.equal(await page.locator('#editor').evaluate(e => e.scrollTop), 0);
    };
    await observe();
    await page.evaluate(() => {
      document.querySelector('[data-node-id="nested"]').firstChild.replaceData(0, 6, 'changed');
      document.querySelector('[data-node-id="p79"]').outerHTML = '<p data-node-id="replacement">replaced owner</p><p data-node-id="inserted">inserted owner</p>';
    });
    await observe();
    await page.evaluate(() => dispatchEvent(new Event('pagehide')));
    await page.evaluate(() => { document.querySelector('[data-node-id="inserted"]').textContent = 'after teardown'; });
    await observe();
  } finally { await browser.close(); }
});
