// Deterministic legacy ProseMirror-shaped Yjs 13 update; no provider/network.
import * as Y from 'yjs';
import { writeFileSync } from 'node:fs';
const document = new Y.Doc();
document.clientID = 424242;
const paragraph = new Y.XmlElement('paragraph');
const text = new Y.XmlText();
text.insert(0, 'old offline edit');
paragraph.insert(0, [text]);
document.getXmlFragment('default').insert(0, [paragraph]);
writeFileSync(new URL('./legacy-yjs.bin', import.meta.url), Y.encodeStateAsUpdate(document));
document.destroy();
