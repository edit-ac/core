import './browser/link-activation.spec.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { init } from '@edit-ac/core';
import { referenceBlock } from '../packages/web/dist/modules/references.js';
import { LinkActivation, bindLinkActivation } from '../packages/web/dist/modules/links/activation.js';
const wasm = readFileSync(new URL('../packages/core/dist/wasm/editac_wasm_bg.wasm', import.meta.url));
const runtime = await init('data:application/wasm;base64,' + wasm.toString('base64'));
const targetId = 'ac://team/71000000-0000-4000-8000-000000000008';
let sequence = 0;
function harness(kind = 'private') {
  const engine = runtime.createEngine({ profile: 'v5', documentId: '71000000-0000-4000-8000-' + String(++sequence).padStart(12, '0'), epoch: '72000000-0000-4000-8000-000000000008', nodes: [{ text: '' }, { text: 'Independent editable text' }] });
  const owner = engine.read().visible[0].id;
  const at = engine.anchor(owner, 0, 'right');
  engine.commit(engine.prepare({ kind: 'fragment', origin: 'extension:activation-fixture', range: { anchor: at, focus: at }, blocks: [kind === 'private' ? referenceBlock({ targetId, label: 'Shared authored label' }) : { attributes: { type: 'paragraph' }, runs: [{ text: 'Shared authored link', marks: [{ mark: 'link', href: 'https://example.test/a%2Fb?q=hello#part' }] }] }] }));
  engine.releaseAnchor(at);
  const node = engine.read().visible.find(n => kind === 'private' ? n.blockAttributes?.[0] === 'module:editac.reference' : n.runs.some(r => r.attributes.link));
  assert.ok(node);
  const h = { engine, calls: [], catalogs: 0, status: 'hosted', locator: targetId, dispatchState: 'available',
    host: { principal: 'alice', tenant: 'tenant1', authority: 'team', scope: { document: engine.read().identity.documentId, session: 'session1', revision: String(engine.read().revision), permission: 'permission1', authorized: true }, policyRevision: 'policy1', readonly: false,
      capabilities: { publicMetadata: false, privateLookup: false, title: false, icon: false, preview: false, activate: true, publishMetadata: false } } };
  h.request = { requestId: 'click1', cancellationToken: 'cancel1', node: node.id, epoch: engine.read().identity.epoch, labelRevision: 'label1', host: structuredClone(h.host), target: kind === 'public' ? { kind, url: 'https://example.test/a%2Fb?q=hello#part' } : { kind, targetId, authority: 'team' }, policy: 'disabled', origin: 'open' };
  h.current = structuredClone(h.request);
  h.controller = new LinkActivation({ context: () => h.host, current: () => {
    if (!engine.read().visible.some(n => n.id === node.id)) return;
    return { ...h.current, host: { ...h.host, scope: { ...h.host.scope, revision: String(engine.read().revision) } } };
  }, catalog: { catalog: id => { h.catalogs++; h.onCatalog?.(); return { targetId: h.catalogId ?? id, status: h.status }; } }, privateLocator: () => { h.onLocator?.(); return h.locator; }, dispatch: action => { h.calls.push(action); return h.dispatchState; } });
  h.before = engine.checkpoint().bytes;
  h.activate = signal => h.controller.perform({ kind: 'activate', request: h.request }, signal);
  h.done = () => { assert.deepEqual(engine.checkpoint().bytes, h.before); h.controller.dispose(); engine.dispose(); };
  return h;
}
for (const kind of ['public', 'private']) {
  test(`${kind}: current readonly navigation and safe copy never write or resolve`, () => {
    const h = harness(kind); h.host.readonly = true;
    assert.equal(h.activate(), 'available'); assert.equal(h.controller.copy(h.request), 'available');
    assert.equal(h.calls.length, 2); assert.ok(Object.isFrozen(h.calls[0])); assert.ok(Object.isFrozen(h.calls[0].target));
    assert.equal(h.calls[0].kind, kind === 'public' ? 'open-external' : 'open-private'); assert.equal(h.calls[1].kind, 'copy-locator'); h.done();
  });
  for (const [field, expected] of [['principal','forbidden'], ['tenant','forbidden'], ['authority','forbidden'], ['permission','forbidden'], ['authorized','forbidden'], ['activate','forbidden'], ['session','stale'], ['revision','stale'], ['policy','stale']]) test(`${kind}: current ${field} invalidation denies with zero dispatch`, () => {
    const h = harness(kind);
    if (field === 'permission' || field === 'session' || field === 'revision') h.host.scope[field] += '-changed';
    else if (field === 'authorized') h.host.scope.authorized = false;
    else if (field === 'activate') h.host.capabilities.activate = false;
    else if (field === 'policy') h.host.policyRevision += '-changed';
    else h.host[field] += '-changed';
    assert.equal(h.activate(), expected); assert.equal(h.calls.length, 0); h.done();
  });
  test(`${kind}: copy is independent of navigation/write permission`, () => {
    const h = harness(kind); h.request.host.capabilities.activate = false; h.current.host.capabilities.activate = false; h.host.capabilities.activate = false; h.host.readonly = true;
    assert.equal(h.activate(), 'forbidden'); assert.equal(h.controller.copy(h.request), 'available'); h.done();
  });
  for (const field of ['node','epoch','requestId','cancellationToken','target']) test(`${kind}: replaced ${field} cannot redirect a captured click`, () => {
    const h = harness(kind);
    if (field === 'target') h.current.target = kind === 'public' ? { kind, url: 'https://attacker.test/' } : { kind, targetId: targetId + '9', authority: 'team' };
    else h.current[field] += '-changed';
    assert.equal(h.activate(), 'stale'); assert.equal(h.calls.length, 0); h.done();
  });
  test(`${kind}: canceled/disposed actions never dispatch`, () => {
    const h = harness(kind), c = new AbortController(); c.abort(); assert.equal(h.activate(c.signal), 'canceled'); h.controller.dispose(); assert.equal(h.activate(), 'canceled'); assert.equal(h.calls.length, 0); h.done();
  });
}
for (const [status, expected] of [['locked','locked'], ['unauthorized','forbidden'], ['unavailable','unavailable'], ['incompatible','unsupported'], ['bad','unsupported']]) test(`private: ${status} catalog is explicit`, () => {
  const h = harness(); h.status = status; assert.equal(h.activate(), expected); assert.equal(h.calls.length, 0); h.done();
});
for (const callback of ['onCatalog', 'onLocator']) test(`private: revocation during ${callback} is checked again`, () => {
  const h = harness(); h[callback] = () => { h.host.capabilities.activate = false; }; assert.equal(h.activate(), 'forbidden'); assert.equal(h.calls.length, 0); h.done();
});
test('private: catalog cannot substitute another identity', () => { const h = harness(); h.catalogId = targetId + 'other'; assert.equal(h.activate(), 'unsupported'); assert.equal(h.calls.length, 0); h.done(); });
for (const value of ['https://user:password@example.test/', 'https://example.test/?access_token=secret', 'https://example.test/?API-Key=secret', 'https://example.test/#access_token=secret', 'https://example.test/?X-Amz-Signature=secret', 'javascript:alert(1)', 'data:text/plain,secret', 'file:///tmp/private', 'https://example.test/\nsecret', 'https://example.test/%0asecret', 'https://example.test/\\evil', 'x'.repeat(4097), 'not a locator']) test(`unsafe locator ${JSON.stringify(value.slice(0,65))}`, () => {
  for (const kind of ['public','private']) { const h = harness(kind); if (kind === 'public') { h.request.target.url = value; h.current.target.url = value; } else h.locator = value;
    assert.equal(h.activate(), 'unsupported'); assert.equal(h.controller.copy(h.request), 'unsupported'); assert.equal(h.calls.length, 0); h.done(); }
});
for (const value of [targetId, 'myapp://team/doc-1', 'https://private.example.test/doc/1']) test(`configured deep locator ${value}`, () => {
  const h = harness(); h.locator = value; assert.equal(h.activate(), 'available'); assert.equal(h.calls[0].locator, value); assert.equal('command' in h.calls[0], false); h.done();
});
for (const value of ['myapp://team/doc?token=secret', 'myapp://team/doc#secret', 'myapp://user:secret@team/doc', 'blob:https://example.test/id']) test(`private deep payload denied ${value}`, () => {
  const h = harness(); h.locator = value; assert.equal(h.activate(), 'unsupported'); assert.equal(h.calls.length, 0); h.done();
});
test('metadata cannot replace the clicked target and shell metacharacters remain URL data', () => {
  const h = harness('public'); h.request.target.url = 'https://example.test/$(touch)?q=hello;world&x=%60id%60'; h.current.target.url = h.request.target.url;
  h.request.metadata = { canonicalUrl: 'https://attacker.test', targetId: 'other' }; assert.equal(h.activate(), 'available'); assert.equal(h.calls[0].locator, h.request.target.url); assert.deepEqual(Object.keys(h.calls[0]).sort(), ['kind','locator','target']); h.done();
});
test('real owning engine edit invalidates the captured reference without dispatch', () => {
  const h = harness(); const owner = h.engine.read().visible.find(n => n.runs.some(r => r.text === 'Independent editable text')).id;
  h.engine.commit(h.engine.prepare({ kind: 'editor', origin: 'extension:activation-fixture', commands: [{ type: 'replaceAt', owner, from: 0, to: 0, text: 'Edited' }] }));
  h.before = h.engine.checkpoint().bytes; assert.equal(h.activate(), 'stale'); assert.equal(h.calls.length, 0); h.done();
});
test('bound click suppresses default navigation on denial and teardown releases listener', () => {
  const h = harness('public'), root = new EventTarget(), results = [];
  const binding = bindLinkActivation(root, h.controller, () => h.request, s => results.push(s));
  assert.equal(h.calls.length, 0); h.host.capabilities.activate = false;
  const event = new Event('click', { cancelable: true }); root.dispatchEvent(event); assert.ok(event.defaultPrevented); assert.deepEqual(results, ['forbidden']);
  binding.dispose(); root.dispatchEvent(new Event('click')); assert.equal(results.length, 1); h.done();
});

test('non-activation portable intents cannot accidentally launch navigation', () => {
  const h = harness('public');
  for (const action of [{ kind: 'lookup', request: h.request, port: 'public' }, { kind: 'copy-locator', target: h.request.target }, { kind: 'commit-metadata', request: h.request, sharedLabel: 'Secret' }]) assert.equal(h.controller.perform(action), 'unsupported');
  assert.equal(h.calls.length, 0); h.done();
});

test('real deleted reference cannot be resurrected or opened by a captured action', () => {
  const h = harness(), nodes = h.engine.read().visible, i = nodes.findIndex(n => n.id === h.request.node);
  const before = nodes[i - 1], after = nodes[i + 1]; assert.ok(before && after);
  const start = h.engine.anchor(before.id, before.runs.map(r => r.text).join('').length, 'right'), end = h.engine.anchor(after.id, 0, 'left');
  try { h.engine.commit(h.engine.prepare({ kind: 'fragment', origin: 'user-delete-reference', range: { anchor: start, focus: end }, blocks: [{ attributes: { type: 'paragraph' }, runs: [{ text: 'Replacement', marks: [] }] }] })); }
  finally { h.engine.releaseAnchor(start); h.engine.releaseAnchor(end); }
  assert.ok(!h.engine.read().visible.some(n => n.id === h.request.node)); h.before = h.engine.checkpoint().bytes;
  assert.equal(h.activate(), 'stale'); assert.equal(h.controller.copy(h.request), 'stale'); assert.equal(h.calls.length, 0); h.done();
});
for (const change of ['cancel', 'dispose', 'switch-target']) test(`private: ${change} during locator admission cannot launch`, () => {
  const h = harness(), signal = new AbortController();
  h.onLocator = () => { if (change === 'cancel') signal.abort(); else if (change === 'dispose') h.controller.dispose(); else h.current.target.targetId += '-changed'; };
  assert.equal(h.activate(signal.signal), change === 'switch-target' ? 'stale' : 'canceled'); assert.equal(h.calls.length, 0); h.done();
});
test('copy cannot bypass a changed owning permission snapshot', () => {
  const h = harness(); h.current.node = 'different'; assert.equal(h.controller.copy(h.request), 'stale'); assert.equal(h.calls.length, 0); h.done();
});
test('host denial and unavailable navigation are reported without mutation', () => {
  const h = harness(); for (const state of ['forbidden', 'unavailable', 'locked']) { h.dispatchState = state; assert.equal(h.activate(), state); }
  h.onLocator = () => { throw Error('prepared secret credential failure'); }; assert.equal(h.activate(), 'unavailable'); assert.equal(h.calls.length, 3); h.done();
});
test('bound successful click opens stored identity; unmatched and failed reads fail safely', () => {
  const h = harness('public'), root = new EventTarget(), results = []; let mode = 'unmatched';
  const binding = bindLinkActivation(root, h.controller, () => { if (mode === 'error') throw Error('bad read'); return mode === 'matched' ? h.request : undefined; }, s => results.push(s));
  const unmatched = new Event('click', { cancelable: true }); root.dispatchEvent(unmatched); assert.ok(!unmatched.defaultPrevented); assert.equal(h.calls.length, 0);
  mode = 'matched'; const matched = new Event('click', { cancelable: true }); root.dispatchEvent(matched); assert.ok(matched.defaultPrevented); assert.equal(h.calls[0].locator, h.request.target.url);
  mode = 'error'; const failed = new Event('click', { cancelable: true }); root.dispatchEvent(failed); assert.ok(failed.defaultPrevented); assert.deepEqual(results, ['available', 'unavailable']); binding.dispose(); h.done();
});

test('matched stale DOM target suppresses default navigation instead of opening stale href', () => {
  const h = harness('public'), root = new EventTarget(), results = [];
  const binding = bindLinkActivation(root, h.controller, () => null, s => results.push(s));
  const event = new Event('click', { cancelable: true }); root.dispatchEvent(event); assert.ok(event.defaultPrevented); assert.deepEqual(results, ['stale']); assert.deepEqual(h.calls, []); binding.dispose(); h.done();
});
