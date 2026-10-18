import assert from 'node:assert/strict';
const forbidden = /\/(?:modules\/(?:code\/(?:presenter|worker|scheduler|backend)|slash|references|reorder|search|content|math|images|embeds|assets|formats)(?:\/|\.js)|extensions\/(?:(?:spelling|authoring|matching|parsing)\.js|runtime\/))/;
export function assertDisabledPresenters(inputs) {
  assert.deepEqual(inputs.filter(path => forbidden.test('/' + path)), [], 'disabled optional presenter implementation in minimal consumer');
}

/** Every emitted byte matters, including deferred chunks outside the eager graph. */
export function assertDisabledOutputs(outputs) {
  const retained = Object.values(outputs).flatMap(output => Object.entries(output.inputs)
    .filter(([, contribution]) => contribution.bytesInOutput > 0).map(([path]) => path));
  assertDisabledPresenters(retained);
}
