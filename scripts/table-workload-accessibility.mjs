// Test-only trusted input and browser AX observations for the existing PRF-04
// corpus. CDP accessibility coverage is not a screen-reader qualification.
const check = (value, message) => { if (!value) throw Error(message); };
export const tableInputScope = 'Chromium trusted keyboard/mouse and emulated touch; complete browser AX cell names/values; no screen-reader/device/compositor qualification';

export async function tableAX(cdp) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  return nodes.filter(n => n.role?.value === 'textbox' && n.name?.value?.startsWith('Table row ')).map(n => ({
    name: n.name?.value, value: n.value?.value, ignored: n.ignored,
    multiline: n.properties?.find(p => p.name === 'multiline')?.value?.value,
  }));
}

export function inspectTableAccessibility(profile, item, rows) {
  check(item.tableAccessibility?.reopened === true && item.tableAccessibility.reopenHash === item.expectedSemanticHash, 'Table persisted reopen missing/mutated');
  return inspectTableInputSamples(profile, item, rows);
}

export function inspectTableInputSamples(profile, item, rows) {
  const raw = item.tableAccessibility, columns = profile.limits.tableColumns;
  const cells = rows.length * columns;
  check(raw?.scope === tableInputScope && profile.tableInputScope === tableInputScope, 'Table input scope missing/drifted');
  check(raw.samples?.length === profile.samples, 'Table trusted input samples missing');
  const expected = rows.flatMap((row, r) => row.map((cell, c) => ({ name: `Table row ${r + 1} column ${c + 1}`, value: cell[0][0], ignored: false, multiline: true })));
  const ax = observations => {
    check(Array.isArray(observations) && observations.length === cells, 'Incomplete table AX cell coverage');
    const sorted = array => [...array].sort((a, b) => a.name.localeCompare(b.name));
    check(JSON.stringify(sorted(observations)) === JSON.stringify(sorted(expected)), 'Table AX cell names/values/visibility differ');
  };
  ax(raw.samples[0].initialAX); ax(raw.samples.at(-1).finalAX);
  const focus = at => ({ row: Math.floor(at / columns), column: at % columns });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [index, sample] of raw.samples.entries()) {
    const target = index === 1 ? columns - 1 : Math.floor(index * (cells - 2) / (profile.samples - 1));
    check(sample.index === index && sample.target === target && sample.semanticRestored === true, 'Table trusted replay identity/restoration differs');
    check(same(sample.mouseFocus, focus(target)) && same(sample.tabFocus, focus(target + 1)) && same(sample.reverseFocus, focus(target)) && same(sample.touchFocus, focus(target + 1)), 'Table keyboard/pointer focus route differs');
    const original = rows[Math.floor((target + 1) / columns)][(target + 1) % columns][0][0];
    const changed = (original[0] === 'z' ? 'y' : 'z') + original.slice(1);
    check(sample.original === original && sample.restoredValue === original && sample.changed === changed && sample.committedValue === changed, 'Table trusted semantic edit missing');
    check(Number.isFinite(sample.start) && sample.start >= 0 && Number.isFinite(sample.end) && sample.end > sample.start, 'Table input timing missing');
    if (index) check(sample.start >= raw.samples[index - 1].end, 'Table input clock reordered');
    const events = sample.events;
    check(Array.isArray(events) && events.length > 0 && events.length <= 100 && events.every(e => e.trusted === true && ['pointerdown', 'keydown', 'beforeinput', 'input'].includes(e.type) && [target, target + 1].some(at => e.row === focus(at).row && e.column === focus(at).column)), 'Synthetic/invalid table input events');
    for (const type of ['mouse', 'touch']) check(events.some(e => e.type === 'pointerdown' && e.pointerType === type), `Missing table ${type} pointer input`);
    check(events.some(e => e.type === 'keydown') && events.filter(e => e.type === 'beforeinput').length === 2 && events.filter(e => e.type === 'input').length === 2, 'Missing trusted table keyboard editing');
  }
  return { samples: raw.samples.length, axCellsPerStage: cells, axStages: 2, scope: tableInputScope, qualification: 'diagnostic' };
}

export async function replayTableInput(page, cdp, profile, scale, index) {
  const cells = profile.limits.tableRows[scale] * profile.limits.tableColumns;
  const target = index === 1 ? profile.limits.tableColumns - 1 : Math.floor(index * (cells - 2) / (profile.samples - 1));
  const controls = page.locator('#editor table textarea');
  check(await controls.count() === cells, 'Trusted table corpus truncated');
  if (index === 0) await page.evaluate(() => {
    window.__tableTrustedEvents = [];
    window.__tableEventListener = event => {
      const at = event.target;
      if (!at.matches?.('#editor table textarea')) return;
      window.__tableTrustedEvents.push({ type: event.type, trusted: event.isTrusted,
        row: Number(at.dataset.row), column: Number(at.dataset.column),
        ...(event.type === 'pointerdown' ? { pointerType: event.pointerType } : {}) });
    };
    for (const type of ['pointerdown', 'keydown', 'beforeinput', 'input']) document.addEventListener(type, window.__tableEventListener, true);
  });
  await page.evaluate(() => { window.__tableTrustedEvents.length = 0; });
  const start = await page.evaluate(() => performance.now());
  const initialAX = index === 0 ? await tableAX(cdp) : undefined;
  const focused = () => page.evaluate(() => {
    const el = document.activeElement;
    return { row: Number(el?.dataset.row), column: Number(el?.dataset.column) };
  });
  await controls.nth(target).click(); const mouseFocus = await focused();
  await page.keyboard.press('Tab'); const tabFocus = await focused();
  await page.keyboard.press('Shift+Tab'); const reverseFocus = await focused();
  await controls.nth(target + 1).scrollIntoViewIfNeeded();
  const box = await controls.nth(target + 1).boundingBox(); check(box, 'Touch cell has no geometry');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  const touchFocus = await focused(), original = await controls.nth(target + 1).inputValue();
  const changed = (original[0] === 'z' ? 'y' : 'z') + original.slice(1);
  // The browser owns selection/input; no dispatchEvent/value assignment.
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(changed);
  await page.waitForFunction(({ at, value }) => window.__tableCommittedCell(at) === value,
    { at: target + 1, value: changed }, { timeout: 5000 }).catch(() => {});
  const committedValue = await page.evaluate(at => window.__tableCommittedCell(at), target + 1);
  if (committedValue !== changed) {
    const diagnostic = await page.evaluate(() => ({ focus: { row: document.activeElement?.dataset.row, column: document.activeElement?.dataset.column },
      status: document.querySelector('[data-content-module="table"] [role="status"]')?.textContent,
      events: [...window.__tableTrustedEvents] }));
    return { index, target, mouseFocus, tabFocus, reverseFocus, touchFocus, original, changed, committedValue,
      initialAX, failure: { phase: 'trusted-edit', ...diagnostic } };
  }
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(original);
  await page.waitForFunction(({ at, value }) => window.__tableCommittedCell(at) === value,
    { at: target + 1, value: original }, { timeout: 5000 });
  const restoredValue = await page.evaluate(at => window.__tableCommittedCell(at), target + 1);
  check(restoredValue === original, 'Trusted table restore did not reach semantic writer');
  const finalAX = index === profile.samples - 1 ? await tableAX(cdp) : undefined;
  const end = await page.evaluate(() => performance.now());
  const events = await page.evaluate(() => [...window.__tableTrustedEvents]);
  if (index === profile.samples - 1) await page.evaluate(() => {
    for (const type of ['pointerdown', 'keydown', 'beforeinput', 'input']) document.removeEventListener(type, window.__tableEventListener, true);
    delete window.__tableEventListener; delete window.__tableTrustedEvents;
  });
  return { index, target, mouseFocus, tabFocus, reverseFocus, touchFocus,
    original, changed, committedValue, restoredValue, start, end, events,
    ...(initialAX ? { initialAX } : {}), ...(finalAX ? { finalAX } : {}) };
}
