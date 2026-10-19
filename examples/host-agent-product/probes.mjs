// Valid, deliberately noncommitting arguments. Missing real services stay absent.
export function probeInput(operation,documentId) {
  const base = { version:1,documentId };
  if (operation === 'read') return { ...base,representation:'source' };
  if (operation === 'prepare') return { ...base,expectedRevision:'fixture-unaccepted',sourceHash:'fixture-unaccepted',candidateMarkdown:'Untrusted prepared text' };
  if (operation === 'apply') return { ...base,expectedRevision:'fixture-unaccepted',proposalId:'fixture-unaccepted',requestId:'fixture-unaccepted' };
  if (operation === 'receipt') return { ...base,requestId:'fixture-unaccepted' };
  return base;
}
