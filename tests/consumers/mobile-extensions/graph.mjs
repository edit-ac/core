import assert from 'node:assert/strict';
const forbidden = /\/(?:modules\/(?:slash|references|reorder|search|content|math|images|embeds|assets|formats)(?:\/|\.js)|extensions\/(?:(?:spelling|authoring|matching|parsing)\.js|runtime\/))/;
export function assertDisabledPresenters(inputs) {
  assert.deepEqual(inputs.filter(path => forbidden.test('/' + path)), [], 'disabled optional presenter implementation in minimal consumer');
}
