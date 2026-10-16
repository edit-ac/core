import { captureAXOwners } from './loading-ax-coverage.mjs';
import { fixture } from '../benchmarks/fixtures.mjs';

export function layoutProbeCss(mode) {
  if (!['control', 'auto', 'auto-dirty', 'layout'].includes(mode)) throw Error('Unknown layout probe');
  // Localize layout/style invalidation without skipping any subtree. Unlike
  // content-visibility:auto, this preserves initial offscreen AX ownership and
  // needs no observer to materialize changed, inserted or replaced owners.
  // Avoid paint/size containment: owners retain their full content geometry.
  if (mode === 'layout') return '#editor > [data-node-id]{contain:layout style}';
  return mode !== 'control' ? '#editor > [data-node-id]{content-visibility:auto;contain-intrinsic-block-size:auto 24px}' : '';
}

// Candidate runs from navigation onward, including every timed pair. Never
// shipped in the SDK. Only the behavior diagnostics run after accepted timing.
export function installLayoutProbe({ enabled, stages = false, mode }) {
  if (mode === 'auto-dirty') {
    let mounted = false;
    const observer = new MutationObserver(records => {
      const root = document.querySelector('#editor');
      if (!root?.children.length) return;
      // The initial projection is published synchronously in one DOM batch.
      // Observe subsequent source changes, not initial owner construction.
      if (!mounted) { mounted = true; return; }
      const materialize = node => {
        let owner = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (!owner || owner === root || !root.contains(owner)) return;
        while (owner.parentElement !== root) owner = owner.parentElement;
        owner.style.contentVisibility = 'visible';
      };
      for (const record of records) {
        // Chromium can retain stale AX text after mutating a skipped owner.
        // Materialize changed owners permanently, including containing lists.
        if (record.target === root) for (const node of record.addedNodes) materialize(node);
        else materialize(record.target);
      }
    });
    observer.observe(document, { childList: true, characterData: true, subtree: true });
    addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }
  if (!enabled) return;
  window.__loadingAXStages = [];
  window.__loadingAXStage = async (editor, stage) => {
    if (!stages) return;
    const owners = editor.read().visible.filter(n => n.kind === 'block').map(n => ({ id: n.id }));
    const coverage = await window.__loadingLayoutAction('ax-owners', { owners });
    window.__loadingAXStages.push({ stage, ...coverage });
  };
  window.__loadingLayoutProbe = async ({ editor, name }) => {
    const root = document.querySelector('#editor');
    const snapshot = editor.read();
    const blocks = snapshot.visible.filter(n => n.kind === 'block');
    const result = { version: 1, scope: 'post-measurement Chromium diagnostic, not screen-reader qualification', cases: [], axStages: window.__loadingAXStages };
    const test = async (name, run) => {
      try { const observations = await run(); result.cases.push({ name, status: 'passed', observations }); }
      catch (error) { result.cases.push({ name, status: 'failed', error: String(error.message), ...(error.observations ? { observations: error.observations } : {}) }); }
    };
    const check = (condition, message) => { if (!condition) throw Error(message); };
    const normalize = text => text.replace(/\s+/gu, ' ').trim();
    const expected = blocks.map(n => n.runs.map(r => r.text).join(''));
    const last = blocks.at(-1), lastText = expected.at(-1);
    const element = id => root.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
    const firstText = el => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); return w.nextNode(); };
    const frame = () => new Promise(requestAnimationFrame);
    await test('offscreen-utf16-selection-and-keyboard', async () => {
      const target = element(last.id), text = firstText(target);
      const offset = text.data.indexOf('😀'); check(offset >= 0, 'Missing surrogate-pair target');
      root.focus();
      const selection = getSelection(), range = new Range(); range.setStart(text, offset); range.setEnd(text, offset + 2);
      selection.removeAllRanges(); selection.addRange(range);
      check(selection.toString() === '😀', 'Offscreen UTF-16 selection differs');
      await window.__loadingLayoutAction('arrow-left');
      check(selection.isCollapsed && selection.anchorNode === text && selection.anchorOffset === offset, 'Keyboard did not collapse at UTF-16 boundary');
      return { utf16Offset: offset, selectedUnits: 2, keyboardCollapsed: true };
    });
    await test('scroll-to-offscreen-range', async () => {
      const target = element(last.id); target.scrollIntoView({ block: 'center' }); await frame(); await frame();
      const text = firstText(target), range = new Range(); range.setStart(text, 0); range.setEnd(text, 1);
      const rect = range.getBoundingClientRect(), viewport = root.getBoundingClientRect();
      check(rect.width > 0 && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom, 'Offscreen range has no visible geometry');
      check(root.scrollTop > 0, 'Did not scroll to last block');
      return { scrollTop: root.scrollTop, rangeWidth: rect.width, rangeHeight: rect.height, visible: true };
    });
    await test('code-and-list-geometry', async () => {
      const code = blocks.findLast(n => n.blockAttributes?.[0] === 'code');
      const nested = blocks.findLast(n => snapshot.visible.some(p => p.id === n.parent && p.kind === 'list'));
      for (const node of [code, nested]) {
        check(node, 'Required geometry family missing'); const el = element(node.id); el.scrollIntoView({ block: 'center' }); await frame(); await frame();
        const rect = el.getBoundingClientRect(); check(rect.height > 0 && rect.width > 0, 'Missing block geometry');
        const range = new Range(); range.selectNodeContents(el); check(range.getClientRects().length > 0, 'Missing text geometry');
      }
      check(element(code.id).tagName === 'PRE' && element(nested.id).tagName === 'LI', 'Code/list structure changed');
      return { code: true, listItem: true, nestedDepth: 1 };
    });
    await test('full-selection-and-copy', async () => {
      root.focus(); const range = new Range(); range.selectNodeContents(root);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const selected = normalize(selection.toString()), oracle = normalize(expected.join(' '));
      check(selected === oracle, 'Full DOM selection omits or changes text');
      check(document.execCommand('copy'), 'Browser copy command rejected');
      const clipboard = normalize(await navigator.clipboard.readText());
      const plainBytes = new TextEncoder().encode(expected.join('\n')).length;
      check(clipboard === oracle, `Actual clipboard text differs from full corpus (plainBytes=${plainBytes}, copiedUnits=${clipboard.length})`);
      return { blocks: blocks.length, selectedUnits: selected.length, copiedUnits: clipboard.length, exactNormalizedText: true };
    });
    await test('bounded-offscreen-clipboard', async () => {
      const target = element(last.id), range = new Range(); range.selectNodeContents(target);
      root.focus(); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      check(document.execCommand('copy'), 'Bounded browser copy rejected');
      check(await navigator.clipboard.readText() === lastText, 'Bounded offscreen copy differs');
      return { exactText: true, copiedUnits: lastText.length };
    });
    await test('native-find-last-block', async () => {
      root.focus(); const range = new Range(); range.setStart(firstText(element(blocks[0].id)), 0); range.collapse(true);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); root.scrollTop = 0;
      check(window.find(lastText, false, false, true), 'Native browser find missed offscreen text');
      const owner = selection.anchorNode?.parentElement?.closest('[data-node-id]');
      check(owner?.dataset.nodeId === last.id && selection.toString() === lastText, 'Native find selected a different block');
      return { foundLastBlock: true, selectedUnits: lastText.length };
    });
    await test('offscreen-public-edit-restore', async () => {
      root.scrollTop = 0; const offset = lastText.search(/[A-Za-z]/), alternate = lastText[offset] === 'z' ? 'q' : 'z';
      check(offset >= 0, 'No offscreen edit target');
      await window.__loadingAXStage(editor, 'before-offscreen-edit');
      for (const value of [alternate, lastText[offset]]) {
        const at = editor.anchor(last.id, offset, 'right'), end = editor.anchor(last.id, offset + 1, 'left');
        try {
          const outcome = editor.chain('layout-probe').command({ type: 'delete', range: { anchor: at, focus: end } }).command({ type: 'insert', at, text: value }).run();
          if (outcome.caret) editor.releaseAnchor(outcome.caret);
          check(editor.read().visible.find(n => n.id === last.id).runs.map(r => r.text).join('') === lastText.slice(0, offset) + value + lastText.slice(offset + 1), 'Offscreen command mismatch');
        } finally { editor.releaseAnchor(at); editor.releaseAnchor(end); }
        await window.__loadingAXStage(editor, value === alternate ? 'after-offscreen-edit' : 'after-offscreen-restore');
      }
      return { changedAndRestored: true };
    });
    await test('accessibility-full-text-and-focus-action', async () => {
      const coverage = await window.__loadingLayoutAction('accessibility', { name, targetId: last.id, owners: blocks.map(n => ({ id: n.id })) });
      if (stages) check(result.axStages.length === 6 && result.axStages.every(s => s.missingIndices.length === 0), 'Incomplete intermediate accessibility owner coverage');
      return coverage;
    });
    getSelection().removeAllRanges(); root.scrollTop = 0;
    return result;
  };
}

export async function runLayoutAction(page, cdp, action, data) {
  if (action === 'arrow-left') { await page.keyboard.press('ArrowLeft'); return; }
  if (action === 'ax-owners') return captureAXOwners(cdp, data.owners);
  if (action !== 'accessibility') throw Error('Unknown layout action');
  await cdp.send('Accessibility.enable');
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const owners = data.owners ? await captureAXOwners(cdp, data.owners, nodes) : undefined;
  const editable = nodes.find(n => !n.ignored && n.role?.value === 'textbox' && n.properties?.some(p => p.name === 'editable' && p.value.value));
  const visited = new Set(), byId = new Map(nodes.map(n => [n.nodeId, n])), actual = [];
  // Protocol inventory order is not reading order (nested lists and refreshed
  // nodes may be serialized later). Follow logical AX child edges instead.
  const visit = id => {
    if (visited.has(id)) throw Error('Cyclic accessibility tree'); visited.add(id);
    const node = byId.get(id); if (!node) throw Error('Incomplete accessibility tree');
    if (!node.ignored && node.role?.value === 'StaticText') actual.push(node.name?.value);
    for (const child of node.childIds ?? []) visit(child);
  };
  for (const id of editable?.childIds ?? []) visit(id);
  const expected = fixture(data.name).blocks.map(b => b.runs.map(r => r.text).join(''));
  const normalize = text => text.replace(/\s+/gu, ' ').trim();
  const actualText = normalize(actual.join(' ')), expectedText = normalize(expected.join(' '));
  if (actualText !== expectedText) {
    const a = [...actualText], e = [...expectedText];
    const at = a.findIndex((c, i) => c !== e[i]);
    const error = Error(`Accessibility text coverage differs: ${actual.length}/${expected.length}; units=${actualText.length}/${expectedText.length}; firstDifferentCodePoint=${at}`);
    error.observations = owners; throw error;
  }
  // Browser focus and keyboard action through a real AX-exposed editable root.
  if (!editable?.backendDOMNodeId) throw Error('No actionable editable AX node');
  await cdp.send('DOM.focus', { backendNodeId: editable.backendDOMNodeId });
  await page.keyboard.press('End');
  const focused = await page.evaluate(() => document.activeElement?.id === 'editor' && !!getSelection()?.rangeCount);
  if (!focused) throw Error('AX editable focus/keyboard action failed');
  return { textNodes: actual.length, expectedBlocks: expected.length, exactText: true, focusAndKeyboard: true, screenReaderQualified: false, ...(owners ? { owners } : {}) };
}
