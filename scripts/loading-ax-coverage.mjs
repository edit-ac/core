// Diagnostic only: preserve logical AX edges and DOM ownership without retaining
// names, text, titles or forcing layout/materializing content-visibility subtrees.
export function inspectAXOwners(nodes, dom, owners) {
  const backend = new Map(), walkDOM = (node, owner) => {
    const attrs = node.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'data-node-id') owner = attrs[i + 1];
    if (node.backendNodeId) backend.set(node.backendNodeId, owner);
    for (const child of node.children ?? []) walkDOM(child, owner);
  };
  walkDOM(dom);
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const editable = nodes.find(n => !n.ignored && n.role?.value === 'textbox' && n.properties?.some(p => p.name === 'editable' && p.value.value));
  if (!editable) throw Error('No editable AX root');
  const visited = new Set(), logical = new Map(), inventory = new Map();
  const add = (map, node) => {
    const owner = backend.get(node.backendDOMNodeId);
    if (owner && !node.ignored && node.role?.value === 'StaticText') map.set(owner, (map.get(owner) ?? 0) + (node.name?.value?.length ?? 0));
  };
  const visit = id => {
    if (visited.has(id)) throw Error('Cyclic AX child edges'); visited.add(id);
    const node = byId.get(id); if (!node) throw Error('Incomplete AX child edges');
    add(logical, node);
    for (const child of node.childIds ?? []) visit(child);
  };
  visit(editable.nodeId); for (const node of nodes) add(inventory, node);
  return { expectedBlocks: owners.length, logicalBlocks: owners.filter(o => logical.has(o.id)).length,
    blocks: owners.map((o, index) => ({ index, owner: o.id, logicalUnits: logical.get(o.id) ?? 0, inventoryUnits: inventory.get(o.id) ?? 0 })),
    missingIndices: owners.flatMap((o, i) => logical.has(o.id) ? [] : [i]) };
}
export async function captureAXOwners(cdp, owners, suppliedNodes) {
  const nodes = suppliedNodes ?? (await cdp.send('Accessibility.getFullAXTree')).nodes;
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  return inspectAXOwners(nodes, root, owners);
}
