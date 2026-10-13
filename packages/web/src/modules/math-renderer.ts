import katex from './vendor/katex.mjs';

// MathML needs no remote assets, CSS, fonts or executable HTML. The verified
// renderer still runs with trust disabled; every call owns fresh macro state.
export function renderMath(source: string, display: boolean, document: Document): Element {
  const markup = katex.renderToString(source, {
    output: 'mathml', displayMode: display, trust: false, throwOnError: true,
    strict: 'error', maxExpand: 256, maxSize: 10, macros: {}, globalGroup: false,
  });
  if (markup.length > 262144) throw Error('Math output bound');
  const template = document.createElement('template'); template.innerHTML = markup;
  const math = template.content.querySelector('math');
  if (!math || template.content.querySelectorAll('*').length > 4096) throw Error('Math output bound');
  for (const element of math.querySelectorAll('*')) {
    if (element.namespaceURI !== 'http://www.w3.org/1998/Math/MathML' ||
        ['annotation-xml', 'mglyph'].includes(element.localName)) throw Error('Unsafe math output');
    for (const attribute of element.attributes) if (/^(?:on|href|src|style)/iu.test(attribute.name)) throw Error('Unsafe math output');
  }
  for (const attribute of math.attributes) if (/^(?:on|href|src|style)/iu.test(attribute.name)) throw Error('Unsafe math output');
  return math;
}
