import { prepareBridge } from './bridge-setup.mjs';
export function prepareHuman(output,facts,receipt) {
  return prepareBridge(output,facts,receipt,{capabilities:true,read:true,human:true,workspace:'human-workspace.mjs',files:['human-view.mjs','read-workspace.mjs'],sources:[
    'examples/host-agent-product/human-setup.mjs','examples/host-agent-product/human-workspace.mjs','examples/host-agent-product/human-view.mjs','examples/host-agent-product/read-workspace.mjs','tests/scenarios/host-agent-product-human.mjs',
  ]});
}
