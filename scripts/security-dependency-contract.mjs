export function parseActiveTree(output) {
  if (typeof output !== 'string' || !output.trim()) throw new Error('Empty active dependency graph');
  return new Set(output.trim().split('\n').map(line => {
    const match = /^(\S+) v(\S+)(?:\s|$)/.exec(line);
    if (!match) throw new Error(`Unrecognized Cargo tree row: ${line}`);
    return `${match[1]}@${match[2]}`;
  }));
}

export function affectedAdvisories(body, queries) {
  if (!queries.length || !Array.isArray(body?.results) || body.results.length !== queries.length || body.results.some(result =>
    !result || typeof result !== 'object' || Array.isArray(result) || result.next_page_token ||
    Object.keys(result).some(key => !['vulns', 'next_page_token'].includes(key)) ||
    (result.vulns !== undefined && (!Array.isArray(result.vulns) || result.vulns.some(vuln => typeof vuln?.id !== 'string' || !vuln.id))))) {
    throw new Error('Invalid, incomplete or paginated OSV response');
  }
  return body.results.flatMap((result, index) => (result.vulns ?? []).map(vuln => ({ ...queries[index], id: vuln.id })));
}
