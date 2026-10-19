import { prepareBridge } from './bridge-setup.mjs';
export function prepareRead(output,facts,receipt) {
  return prepareBridge(output,facts,receipt,{ capabilities:true,read:true,workspace:'read-workspace.mjs',sources:[
    'examples/host-agent-product/read-setup.mjs','examples/host-agent-product/read-workspace.mjs',
    'tests/scenarios/host-agent-product-read.mjs',
  ] });
}
