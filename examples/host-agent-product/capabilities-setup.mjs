import { prepareBridge } from './bridge-setup.mjs';
export function prepareCapabilities(output,facts,receipt) {
  return prepareBridge(output,facts,receipt,{ capabilities:true,workspace:'capabilities-workspace.mjs',sources:[
    'examples/host-agent-product/capabilities-setup.mjs','examples/host-agent-product/capabilities-workspace.mjs',
    'examples/host-agent-product/probes.mjs','tests/scenarios/host-agent-product-capabilities.mjs',
  ] });
}
