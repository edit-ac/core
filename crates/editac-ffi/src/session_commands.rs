//! Additive owned transport values for the serial NativeSession worker.
//! Portable EditorCommand JSON and first-party profile IDs are authoritative.
//! Route metadata describes module/admission support; target enablement always
//! calls the existing EditService planner through check_commands.
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativePreparedCommands {
    pub token: String,
    pub revision: Vec<u8>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeCommandRoute {
    /// Exact EditorCommand.type from packages/core/src/engine.ts.
    pub id: String,
    pub available: bool,
    /// Admission only. Target applicability must pass check_commands/prepare_commands.
    pub can_prepare: bool,
    pub reason: String,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeCommandProfile {
    /// Existing FIRST_PARTY_PROFILES / FIRST_PARTY_FEATURES IDs.
    pub id: String,
    pub available: bool,
    pub reason: String,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeCommandCatalog {
    pub revision: Option<Vec<u8>>,
    pub schema: String,
    pub profile: String,
    pub routes: Vec<NativeCommandRoute>,
    pub profiles: Vec<NativeCommandProfile>,
}
