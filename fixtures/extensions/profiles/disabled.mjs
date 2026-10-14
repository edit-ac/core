import {FIRST_PARTY_PROFILES,FIRST_PARTY_FEATURES,prepareExtensionProfile,ExtensionProfileActivation} from '@edit-ac/core/extensions';
const prepared=prepareExtensionProfile(FIRST_PARTY_PROFILES.core,FIRST_PARTY_FEATURES,{schema:'editac.registry.editor.v5',capabilities:[]});
const activation=new ExtensionProfileActivation(prepared);
await activation.activate({'editac.slash':async()=>{const feature=await import('/optional-feature.js');return feature.mount();}});
activation.dispose();
window.profileDisabled={resources:activation.resourceCount,diagnostics:activation.takeDiagnostics()};
