// Evidence inventory only. Runtime authority remains in the owning presenter and
// engine. Exact label comparison detects newly advertised, unqualified actions.
export const commandProfiles = [
  { id: 'code', owner: 'extensions/code.ts', options: { code: true, codeTools: true }, selector: '[data-code-commands]',
    commands: ['Move code lines up','Move code lines down','Duplicate code lines','Indent code lines','Outdent code lines','Surround code selection','Toggle code comments'], permission: 'read-only/blocked context; no separate host permission port' },
  { id: 'reorder', owner: 'modules/reorder.ts', options: { reorder: true, nodes: [{text:'alpha'},{text:'beta'},{text:'gamma'}] }, selector: '[aria-label="Reorder block"]',
    commands: ['Move block up','Move block down','Drag selected block'], permission: 'read-only/blocked context; no separate host permission port' },
  { id: 'table', owner: 'modules/content.ts', options: { table: true }, selector: '[data-content-module="table"]',
    commands: ['Format table source','Insert row before','Insert row after','Remove rows','Insert column before','Insert column after','Remove columns',
      'Bold cells','Italic cells','Underline cells','Strike cells','Code cells','Link cells','Remove cell link',
      'Paragraph cells','Heading 1 cells','Heading 2 cells','Heading 3 cells','Heading 4 cells','Heading 5 cells','Heading 6 cells','Code block cells',
      'Header cells','Body cells','Align cells none','Align cells left','Align cells center','Align cells right','Extend table selection'], unavailable: ['Format table source'], selectionOnly: ['Extend table selection'], derivedControls: Array.from({length:2},(_,r)=>Array.from({length:4},(_,c)=>`Select row ${r+1} column ${c+1}`)).flat(), permission: 'read-only and protected-cell policy; no global grant inferred' },
  { id: 'search', owner: 'modules/search.ts', options: { facade: 'search' }, selector: '[data-document-search]',
    commands: ['Find in document','Find in selection','Previous match','Next match','Replace current','Replace all','Close find'],
    writes: ['Replace current','Replace all'], permission: 'read-only plus explicit replacement authorize callback' },
  { id: 'slash', owner: 'modules/slash.ts', options: { facade: 'slash' }, selector: '[aria-label="Slash commands"]',
    commands: ['Make code block'], permission: 'read-only/blocked context plus per-command disabled metadata' },
];
export const hostProfiles = [
  { id:'references', owner:'modules/references.ts', available:true, enabled:true, qualified:false,
    commands:['Insert reference','Close references','Prepared local target'], permission:'ReferenceHostV1 lookup/insert, catalog and revision',
    states:['ready','denied','denied-insert','unknown','rejected','delayed','revoked'] },
];
// These entries make unfinished ownership visible; a prepared baseline API result
// is not proof of the future owning mobile adapter or its OS delivery.
export const pendingOwners = [
  { id:'assets/embeds', parent:'MEX-1.5', state:'owning host absence/rejection envelope not yet admitted' },
  { id:'formats/share', parent:'MEX-1.6', state:'qualified direction/fidelity and owning delivery fallbacks pending' },
  { id:'assistance', parent:'MEX-1.7', state:'exact AIN admission pending; no provider or microphone work' },
  { id:'extension-formatting/paste', parent:'MEX-1.9', state:'shared map and owning codec/source-preserving fallback pending' },
];
export const portableCommandIds=['enter','break','backward','forward','indent','outdent','bold','italic','underline','strike','code','link','undo','redo','replace'];
export const firstPartyIds=['editac.slash','editac.references','editac.reorder','editac.images','editac.tables','editac.math','editac.search','editac.code','editac.pairs'];
