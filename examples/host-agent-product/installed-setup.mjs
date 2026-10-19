import { prepareBridge } from './bridge-setup.mjs';
export function prepareWorkspace(output,facts,receipt){
  return prepareBridge(output,facts,receipt,{capabilities:true,read:true,human:true,workspace:'installed-workspace.mjs',files:['human-workspace.mjs','human-view.mjs','read-workspace.mjs'],sources:[
    'scripts/check-host-agent-product.mjs','examples/host-agent-product/installed-setup.mjs','examples/host-agent-product/installed-workspace.mjs','examples/host-agent-product/human-workspace.mjs','examples/host-agent-product/human-view.mjs','examples/host-agent-product/read-workspace.mjs','tests/scenarios/host-agent-product-workspace.mjs','tests/scenarios/host-agent-product-human.mjs',
  ]});
}
