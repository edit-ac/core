/** Browser strings must be checked before crossing JSON/WASM/UTF-8 boundaries.
 * TAB and line endings are supported literal data; other C0/C1 controls are
 * unsupported. Bidi, joiners, variation selectors and authored spaces are data.
 */
export function inputTextDiagnostic(text: string): string | undefined {
  for (let offset = 0; offset < text.length; offset++) {
    const unit = text.charCodeAt(offset);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(offset + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return `malformed-utf16:${offset}`;
      offset++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return `malformed-utf16:${offset}`;
    else if ((unit < 0x20 && unit !== 9 && unit !== 10 && unit !== 13) || (unit >= 0x7f && unit <= 0x9f)) return `unsupported-control:${offset}`;
  }
  return undefined;
}

/** Literal import only: never normalize Unicode, trim, collapse or expand tabs. */
export function literalLineEndings(text: string): string { return text.replace(/\r\n?/g, '\n'); }

/** Display-only UTF-16 diagnostics, bounded independently of authored content. */
export function invisibleCharacterSummary(text: string): string {
  const found: string[] = [];
  for (let offset = 0; offset < text.length; offset++) {
    const unit = text.charCodeAt(offset);
    if ([9, 10, 13, 32, 0xa0, 0x202f, 0xfeff].includes(unit) || unit >= 0x200b && unit <= 0x200f || unit >= 0x202a && unit <= 0x202e || unit >= 0x2060 && unit <= 0x2069) {
      found.push(`U+${unit.toString(16).toUpperCase().padStart(4, '0')}@${offset}`);
      if (found.length === 64) { found.push('…'); break; }
    }
  }
  return found.length ? `Invisible characters (UTF-16): ${found.join(', ')}` : '';
}
