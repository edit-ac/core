import { type EngineHandle, type EngineRuntime, type PrepareRequest, type AnchorToken, EngineError } from '@edit-ac/core';
function consumer(runtime: EngineRuntime): EngineHandle {
  const e = runtime.createEngine({ profile: 'v5', documentId: 'host-id', epoch: 'host-epoch', nodes: [{ text: '' }] });
  const node = e.read().visible[0]!;
  const anchor: AnchorToken = e.anchor(node.id, 0, 'right');
  const request: PrepareRequest = { kind: 'text', origin: 'typing', command: { type: 'insert', at: anchor, text: 'a' } };
  e.commit(e.prepare(request));
  e.resolve(anchor); e.history({ type: 'composition', session: 1 }); e.releaseAnchor(anchor); e.dispose();
  // @ts-expect-error raw strings cannot become stable anchors
  e.resolve('unscoped');
  // @ts-expect-error offsets are numbers, never strings
  e.anchor(node.id, '0', 'right');
  // @ts-expect-error text plans do not accept structural commands
  e.prepare({ kind: 'text', origin: 'typing', command: { type: 'join', first: node.id, second: node.id } });
  // @ts-expect-error a history operation is not a document command
  e.prepare({ kind: 'editor', origin: 'typing', commands: [{ type: 'undo' }] });
  return e;
}
void consumer; void EngineError;
