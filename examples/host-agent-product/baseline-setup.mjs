import { prepareBridge } from './bridge-setup.mjs';
export function prepareBaseline(output,facts,receipt) {
  return prepareBridge(output,facts,receipt,{capabilities:true,read:true,human:true,baseline:true,workspace:'baseline-workspace.mjs',
    files:['human-workspace.mjs','human-view.mjs','read-workspace.mjs'],sources:[
      'examples/host-agent-product/baseline-setup.mjs','examples/host-agent-product/baseline-workspace.mjs','examples/host-agent-product/human-workspace.mjs','examples/host-agent-product/human-view.mjs','examples/host-agent-product/read-workspace.mjs','tests/scenarios/host-agent-product-baseline.mjs',
    ]});
}
