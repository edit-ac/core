/** Safe presentation/admission URLs. Imported HTML requires absolute URLs and
 * rejects credentials/encoded controls; stored projections resolve against the host. */
export function safeLink(value: unknown, base?: string): string | null {
  if (typeof value !== 'string') return null;
  const strict = base === undefined;
  if (strict && (value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(value))) return null;
  try {
    const url = new URL(value, base);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) && (!strict || !url.username && !url.password) ? strict ? value : url.href : null;
  } catch { return null; }
}
