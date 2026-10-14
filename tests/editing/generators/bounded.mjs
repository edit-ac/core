import assert from 'node:assert/strict';

export function random(seed) {
  assert.ok(Number.isInteger(seed) && seed > 0 && seed <= 0xffffffff);
  let state = seed >>> 0;
  return bound => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % bound; };
}
// Scalar boundaries preserve original NFC/NFD/ZWJ spelling; these are not grapheme boundaries.
export function boundaries(text) {
  const result = [0]; let offset = 0;
  for (const point of text) { offset += point.length; result.push(offset); }
  return result;
}
export function validTrace(trace, initial = '') {
  let text = initial;
  for (const op of trace) {
    const valid = boundaries(text);
    if (!valid.includes(op.from) || !valid.includes(op.to) || op.to < op.from || typeof op.text !== 'string') return false;
    text = text.slice(0, op.from) + op.text + text.slice(op.to);
  }
  return true;
}
export function commandTrace(seed, profile) {
  const next = random(seed), trace = []; let text = '';
  for (let i = 0; i < profile.steps; i++) {
    const points = boundaries(text), a = next(points.length), b = next(points.length);
    const from = points[Math.min(a, b)], to = points[Math.max(a, b)];
    const insert = profile.vectors[next(profile.vectors.length)];
    const op = { from, to, text: insert, backward: next(2) === 1 };
    text = text.slice(0, from) + insert + text.slice(to);
    assert.ok(text.length <= profile.maxUtf16Length, 'bounded generated state');
    trace.push(op);
  }
  assert.ok(validTrace(trace));
  return trace;
}
/** Deterministic 1-minimal deletion reducer. Every candidate is replay-admissible. */
export function shrink(trace, fails, initial = '') {
  assert.ok(validTrace(trace, initial)); assert.ok(fails(trace));
  let result = structuredClone(trace), attempts = 0, changed = true;
  const check = candidate => { attempts++; return validTrace(candidate, initial) && fails(candidate); };
  while (changed) {
    changed = false;
    for (let i = result.length - 1; i >= 0; i--) {
      const candidate = result.toSpliced(i, 1);
      if (check(candidate)) { result = candidate; changed = true; }
    }
    // Payload reduction can make a previously necessary action removable.
    for (let i = 0; i < result.length; i++) {
      for (let n = [...result[i].text].length - 1; n >= 0; n--) {
        const candidate = structuredClone(result); candidate[i].text = [...candidate[i].text].slice(0, n).join('');
        if (check(candidate)) { result = candidate; changed = true; }
      }
    }
  }
  assert.ok(validTrace(result, initial)); assert.ok(fails(result));
  assert.ok(result.every((_, i) => !check(result.toSpliced(i, 1))), 'deletion minimality');
  return { trace: result, attempts, minimality: 'one-operation deletion and Unicode-scalar prefix reduction' };
}
