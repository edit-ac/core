//! Native host capability transport. Only caller-approved original bytes are read;
//! document metadata never grants access and no paths/URLs are accepted.
use super::*;
use editac_core::modules::assets::{AssetAction, AssetGrant, AssetIdentity, AssetRequest};
use editac_session::{
    assets::{AssetHost, HostOutcome},
    ports::PortError,
};

#[derive(Default)]
pub struct Media {
    approved: Vec<(AssetIdentity, Vec<u8>)>,
    pub reads: usize,
    pub cancellation: Option<Cancellation>,
    #[cfg(feature = "qualification")]
    mode: String,
}
impl Media {
    pub fn from_request(request: &Value) -> Result<Self, String> {
        let mut host = Self::default();
        if let Some(assets) = request.get("approvedAssets") {
            let assets = assets
                .as_array()
                .filter(|a| a.len() <= 64)
                .ok_or("FORMAT_ASSET_CAPABILITY_INVALID")?;
            let mut total = 0usize;
            for a in assets {
                let identity = AssetIdentity {
                    host: a["host"]
                        .as_str()
                        .ok_or("FORMAT_ASSET_CAPABILITY_INVALID")?
                        .into(),
                    key: a["key"]
                        .as_str()
                        .ok_or("FORMAT_ASSET_CAPABILITY_INVALID")?
                        .into(),
                };
                identity
                    .validate()
                    .map_err(|_| "FORMAT_ASSET_CAPABILITY_INVALID")?;
                if host.approved.iter().any(|(i, _)| *i == identity) {
                    return Err("FORMAT_ASSET_CAPABILITY_INVALID".into());
                }
                let bytes: Vec<u8> = serde_json::from_value(a["bytes"].clone())
                    .map_err(|_| "FORMAT_ASSET_CAPABILITY_INVALID")?;
                total = total
                    .checked_add(bytes.len())
                    .filter(|n| *n <= LIMITS.input_bytes)
                    .ok_or("FORMAT_INPUT_LIMIT")?;
                host.approved.push((identity, bytes));
            }
        }
        #[cfg(not(feature = "qualification"))]
        if request.get("assetProbe").is_some() {
            return Err("FORMAT_PROFILE_UNAVAILABLE".into());
        }
        #[cfg(feature = "qualification")]
        {
            host.mode = request["assetProbe"].as_str().unwrap_or("").into();
        }
        Ok(host)
    }
}
impl AssetHost for Media {
    fn authorize(&mut self, r: &AssetRequest) -> Result<AssetGrant, PortError> {
        if r.action != AssetAction::Read
            || !self
                .approved
                .iter()
                .any(|(i, b)| *i == r.identity && b.len() as u64 <= r.byte_limit)
        {
            return Err(PortError::Permission);
        }
        Ok(AssetGrant {
            identity: r.identity.clone(),
            actions: vec![AssetAction::Read],
        })
    }
    fn execute(&mut self, _: &str, _: &AssetRequest) -> Result<HostOutcome, PortError> {
        Err(PortError::Permission)
    }
}
impl Media {
    pub fn read_original(&mut self, r: &AssetRequest) -> Result<Vec<u8>, PortError> {
        self.authorize(r)?;
        self.reads += 1;
        #[cfg(feature = "qualification")]
        match self.mode.as_str() {
            "fail" => return Err(PortError::Unavailable),
            "cancel" => self.cancellation.as_ref().unwrap().cancel(),
            _ => {}
        }
        self.approved
            .iter()
            .find(|(i, _)| *i == r.identity)
            .map(|(_, b)| b.clone())
            .ok_or(PortError::Permission)
    }
}
