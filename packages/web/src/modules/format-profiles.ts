/** Descriptive installed-package metadata, never a converter registry. The host
 * authenticates the immutable package and its direction-specific proof before
 * supplying it. Metadata grants no conversion or asset authority. */
export interface FormatProfileSource {
  provenance: string;
  manifest: unknown;
}
export interface FormatProfileDirection {
  readonly format: string;
  readonly direction: 'import' | 'export';
  readonly profile: string;
  readonly fidelity: string;
}

/** Validate the entire inventory before rendering it. Native-only rows cannot
 * advertise browser capabilities; PDF can never advertise import. */
export function browserFormatProfiles(source: FormatProfileSource): readonly FormatProfileDirection[] {
  const manifest = source.manifest as { schemaVersion?: unknown; directions?: unknown } | null;
  if (typeof source.provenance !== 'string' || !source.provenance.trim() || source.provenance.length > 512 ||
      manifest?.schemaVersion !== 1 || !Array.isArray(manifest.directions) || manifest.directions.length > 64) {
    throw Error('format-profile-manifest-invalid');
  }
  const rows: FormatProfileDirection[] = [], seen = new Set<string>();
  for (const row of manifest.directions) {
    if (!row || typeof row !== 'object') throw Error('format-profile-manifest-invalid');
    if (row.target !== 'browser-worker-wasm32') continue;
    if (!['rtf', 'csv', 'tsv', 'docx', 'odt', 'epub', 'pdf'].includes(row.format) ||
        !['import', 'export'].includes(row.direction) || (row.format === 'pdf' && row.direction !== 'export') ||
        ![row.profile, row.fidelity].every(value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value))) {
      throw Error('format-profile-direction-invalid');
    }
    const key = `${row.format}:${row.direction}`;
    if (seen.has(key)) throw Error('format-profile-direction-duplicate');
    seen.add(key);
    rows.push(Object.freeze({ format: row.format, direction: row.direction, profile: row.profile, fidelity: row.fidelity }));
  }
  if (!rows.length) throw Error('format-profile-browser-unavailable');
  return Object.freeze(rows);
}
