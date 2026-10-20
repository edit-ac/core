import { prepareBridge } from './bridge-setup.mjs';
export function prepareProposalCancel(output,facts,receipt) {
  return prepareBridge(output,facts,receipt,{capabilities:true,read:true,human:true,baseline:true,workspace:'proposal-cancel-workspace.mjs',
    files:['human-workspace.mjs','human-view.mjs','read-workspace.mjs','baseline-workspace.mjs','upload-workspace.mjs','upload-input.mjs'],sources:[
      'examples/host-agent-product/proposal-cancel-setup.mjs','examples/host-agent-product/proposal-cancel-workspace.mjs','examples/host-agent-product/upload-workspace.mjs','examples/host-agent-product/upload-input.mjs','examples/host-agent-product/baseline-workspace.mjs','examples/host-agent-product/human-workspace.mjs','examples/host-agent-product/human-view.mjs','examples/host-agent-product/read-workspace.mjs','tests/scenarios/host-agent-product-proposal-cancel.mjs',
    ]});
}
