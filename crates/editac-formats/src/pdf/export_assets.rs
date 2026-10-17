//! Original PNG capability bridge. No URL lookup, filesystem or preview bytes.
use super::export::Report;
use crate::job::*;
use editac_core::modules::assets::*;
use editac_session::{
    assets::{AssetHost, AssetStore, HostOutcome},
    ports::PortError,
    session::SessionStore,
};
use krilla::image::Image;
use sha2::{Digest, Sha256};

/// The host bounds the read before allocating and returns the granted original.
/// Authorization and durable scoped cleanup still run through AssetWork.
pub trait OriginalAssetHost: AssetHost {
    fn read_original(&mut self, request: &AssetRequest) -> Result<Vec<u8>, PortError>;
}
pub(crate) struct Unavailable;
impl AssetHost for Unavailable {
    fn authorize(&mut self, _: &AssetRequest) -> Result<AssetGrant, PortError> {
        Err(PortError::Unavailable)
    }
    fn execute(&mut self, _: &str, _: &AssetRequest) -> Result<HostOutcome, PortError> {
        Err(PortError::Unavailable)
    }
}
impl OriginalAssetHost for Unavailable {
    fn read_original(&mut self, _: &AssetRequest) -> Result<Vec<u8>, PortError> {
        Err(PortError::Unavailable)
    }
}
struct Reader<'a, H> {
    host: &'a mut H,
    bytes: Option<Vec<u8>>,
}
impl<H: OriginalAssetHost> AssetHost for Reader<'_, H> {
    fn authorize(&mut self, r: &AssetRequest) -> Result<AssetGrant, PortError> {
        self.host.authorize(r)
    }
    fn execute(&mut self, reference: &str, r: &AssetRequest) -> Result<HostOutcome, PortError> {
        if r.action != AssetAction::Read {
            return self.host.execute(reference, r);
        }
        let bytes = self.host.read_original(r)?;
        if bytes.len() as u64 > r.byte_limit {
            return Err(PortError::Quota);
        }
        self.bytes = Some(bytes);
        Ok(HostOutcome::Complete)
    }
}
pub(crate) fn load<S: SessionStore + AssetStore, H: OriginalAssetHost>(
    job: &mut PreparedJob<S>,
    host: &mut H,
    descriptor: &AssetDescriptor,
    report: &mut Report,
    now: &mut impl FnMut() -> u64,
) -> Result<Image, String> {
    let limit = descriptor
        .metadata
        .byte_length
        .ok_or("ASSET_LENGTH_REQUIRED")?;
    let mut reader = Reader { host, bytes: None };
    job.stage_asset(
        descriptor.identity.clone(),
        AssetAction::Read,
        limit,
        &mut reader,
        now(),
    )
    .map_err(|e| format!("ASSET_READ:{e:?}"))?;
    job.check(now()).map_err(|e| format!("JOB:{e:?}"))?;
    let bytes = reader.bytes.take().ok_or("ASSET_READ_MISSING")?;
    if bytes.len() as u64 != limit
        || descriptor.metadata.sha256.as_deref() != Some(&format!("{:x}", Sha256::digest(&bytes)))
    {
        return Err("ASSET_IDENTITY_MISMATCH".into());
    }
    // Reject unbounded ancillary/profile/animation processing before the library
    // reads metadata or creates its deferred raster decoder. Only 8-bit static
    // non-interlaced PNG with literal IHDR/IDAT/IEND chunks is qualified here.
    if bytes.len() < 45
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || &bytes[12..16] != b"IHDR"
        || bytes[24] != 8
        || !matches!(bytes[25], 0 | 2 | 4 | 6)
        || bytes[26..29] != [0, 0, 0]
    {
        return Err("ASSET_PNG_PROFILE".into());
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if w == 0
        || h == 0
        || Some(w) != descriptor.metadata.width
        || Some(h) != descriptor.metadata.height
    {
        return Err("ASSET_DIMENSIONS".into());
    }
    let pixels = (w as usize)
        .checked_mul(h as usize)
        .ok_or("IMAGE_PIXEL_LIMIT")?;
    let total = report
        .pixels
        .checked_add(pixels)
        .filter(|n| *n <= 1_048_576)
        .ok_or("IMAGE_PIXEL_LIMIT")?;
    let mut position = 8usize;
    let mut data = false;
    let mut end_seen = false;
    let mut chunks = 0;
    while position < bytes.len() {
        job.check(now()).map_err(|e| format!("JOB:{e:?}"))?;
        chunks += 1;
        if chunks > 256 || end_seen {
            return Err("ASSET_PNG_CHUNKS".into());
        }
        let n = u32::from_be_bytes(
            bytes
                .get(position..position + 4)
                .ok_or("ASSET_PNG_CHUNKS")?
                .try_into()
                .unwrap(),
        ) as usize;
        let end = position
            .checked_add(n)
            .and_then(|n| n.checked_add(12))
            .filter(|n| *n <= bytes.len())
            .ok_or("ASSET_PNG_CHUNKS")?;
        match &bytes[position + 4..position + 8] {
            b"IHDR" if position == 8 && n == 13 => {}
            b"IDAT" => data = true,
            b"IEND" if data && n == 0 && end == bytes.len() => end_seen = true,
            _ => return Err("ASSET_PNG_CHUNKS".into()),
        }
        position = end;
    }
    if !end_seen {
        return Err("ASSET_PNG_CHUNKS".into());
    }
    // Reserve cumulative expanded pixels before metadata/deferred decode and
    // bound each library allocation to <=4 MiB samples (plus channel copies).
    report.pixels = total;
    let mut work = crate::media::Work {
        pixels: total - pixels,
        decoded_bytes: (total - pixels) * 4,
        scanned: report.png_scan_bytes,
        decode_calls: report.png_scan_calls,
        ..Default::default()
    };
    let validation = crate::media::validate_png(
        &bytes,
        "publication-original",
        &mut work,
        crate::media::Budgets {
            pixels: 1_048_576,
            decoded_bytes: 4 * 1_048_576,
            ..Default::default()
        },
        &mut || {
            job.check(now()).map_err(|e| {
                crate::media::Failure::new(
                    if matches!(e, JobError::Timeout) {
                        crate::media::Code::Timeout
                    } else {
                        crate::media::Code::Cancelled
                    },
                    "publication-original",
                )
            })
        },
    );
    report.png_scan_bytes = work.scanned;
    report.png_scan_calls = work.decode_calls;
    validation.map_err(|e| format!("ASSET_PNG_SCAN:{:?}", e.code))?;
    report.original_bytes += bytes.len();
    Image::from_png(bytes.into(), false).map_err(|e| format!("ASSET_PNG_DECODE:{e}"))
}
