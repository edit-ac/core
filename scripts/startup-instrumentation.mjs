// Exact transforms apply only to the installed packed diagnostic derivative.
// Milestones expose closed names and clocks, never document or host payloads.
export function instrumentStartupSource(kind, source) {
  const end = kind === 'render' ? source.indexOf('    getBlock(') : source.length;
  if (end < 0) throw Error('Missing render constructor boundary');
  const suffix = source.slice(end); source = source.slice(0, end);
  const points = {
    entry: [
      ['const identity = { ...options.identity };', 'recovery.begin', false],
      ['const runtime = await init(options.assetUrl);', 'recovery.runtime', true],
      ['const checkpoints = await CheckpointStorage.open(options.indexedDB, options.databaseName);', 'recovery.checkpointOpen', true],
      ['journal = await UpdateJournal.open(options.indexedDB, options.databaseName);', 'recovery.journalOpen', true],
      ['writer = await recovered.value;', 'recovery.writerRestore', true],
      ['const storage = new LocalStorageLifecycle(writer, journal);', 'recovery.lifecycle', true],
    ],
    checkpoint: [
      ['const raw = await this.#readRaw(expected);', 'checkpoint.read', true],
      ['const entries = await verifyEntries(raw.entries, expected);', 'checkpoint.entries', true],
      ['const valid = await validate(candidate, expected);', 'checkpoint.validated', true],
    ],
    writer: [
      ['const engine = runtime.restoreEngine(expected, checkpoint, tail);', 'writer.restored', true],
      ['writerId = engine.checkpoint().writerId;', 'writer.checkpoint', true],
    ],
    editor: [
      ['this.#session = session;', 'surface.begin', true],
      ['this.#renderer = this.#surface.renderer;', 'surface.bound', false],
      ["this.lifecycle.update({ phase: 'ready', ready: true, visible: true, preview });", 'surface.ready', true],
    ],
    render: [
      ['const snapshot = engine.read();', 'render.begin', false],
      ['const snapshot = engine.read();', 'render.snapshot', true],
      ['root.replaceChildren();', 'render.modules', false],
      ['const nodes = new Map(snapshot.visible.map(node => [node.id, node]));', 'render.domBegin', false],
      ['root.append(this.#arrange(root.ownerDocument.createDocumentFragment()));', 'render.nodes', false],
      ['root.append(this.#arrange(root.ownerDocument.createDocumentFragment()));', 'render.arranged', true],
      ['this.#subscription = engine.subscribe({ type: "all" }, patch => this.#apply(patch));', 'render.subscribed', true],
    ],
  }[kind];
  if (!points) throw Error(`Unknown startup source: ${kind}`);
  // Validate against the original so a duplicate cannot evade exact matching.
  for (const [text] of points) if (source.split(text).length !== 2) throw Error(`Unrecognized startup boundary: ${kind}: ${text}`);
  // Reverse handles before/after markers on the same statement deterministically.
  for (const [text, name, after] of [...points].reverse()) {
    const marker = `globalThis.__editacStartupMark(${JSON.stringify(name)});`;
    source = source.replace(text, after ? `${text}\n${marker}` : `${marker}\n${text}`);
  }
  return source + suffix;
}
