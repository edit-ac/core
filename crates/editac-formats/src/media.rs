//! Shared bounded PNG scan and ingress work budgets; no raster allocation.
#[derive(Clone, Copy, Debug)]
pub struct Budgets {
    pub input: usize,
    pub entries: usize,
    pub part: usize,
    pub inflated: usize,
    pub ratio: usize,
    pub depth: usize,
    pub attributes: usize,
    pub text: usize,
    pub nodes: usize,
    pub work: usize,
    pub pixels: usize,
    pub decoded_bytes: usize,
}
impl Default for Budgets {
    fn default() -> Self {
        Self {
            input: 1024 * 1024,
            entries: 256,
            part: 2 * 1024 * 1024,
            inflated: 2 * 1024 * 1024,
            ratio: 100,
            depth: 64,
            attributes: 64,
            text: 2 * 1024 * 1024,
            nodes: 4096,
            work: 32 * 1024 * 1024,
            pixels: 16 * 1024 * 1024,
            decoded_bytes: 64 * 1024 * 1024,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    Budget,
    Path,
    Duplicate,
    Archive,
    Encryption,
    Symlink,
    Xml,
    Encoding,
    Dtd,
    NestedPackage,
    ContentType,
    Relationship,
    Media,
    Cancelled,
    Timeout,
    Cleanup,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: Code,
    pub part: String,
    pub work: Work,
}
impl Failure {
    pub fn new(code: Code, part: &str) -> Self {
        Self {
            code,
            part: part.chars().take(256).collect(),
            work: Work::default(),
        }
    }
}
type Result<T> = std::result::Result<T, Failure>;
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Work {
    pub entries: usize,
    pub inflated: usize,
    pub scanned: usize,
    pub nodes: usize,
    pub text: usize,
    pub references: usize,
    pub media_attempts: usize,
    pub pixels: usize,
    pub decoded_bytes: usize,
    pub media_inflated: usize,
    pub decode_calls: usize,
}
pub(crate) fn add(value: &mut usize, amount: usize, max: usize, part: &str) -> Result<()> {
    let next = value
        .checked_add(amount)
        .filter(|n| *n <= max)
        .ok_or_else(|| Failure::new(Code::Budget, part))?;
    *value = next;
    Ok(())
}
fn crc32(bytes: &[u8]) -> u32 {
    let mut n = !0u32;
    for byte in bytes {
        n ^= *byte as u32;
        for _ in 0..8 {
            n = (n >> 1) ^ if n & 1 == 1 { 0xedb88320 } else { 0 };
        }
    }
    !n
}
/// Bounded original-PNG validation, not a preview or general image decoder.
/// This profile admits 8-bit noninterlaced grayscale/RGB/gray-alpha/RGBA.
/// Scanline zlib bytes are validated in a fixed scratch buffer; no raster is allocated.
pub(crate) fn validate_png(
    bytes: &[u8],
    name: &str,
    work: &mut Work,
    limits: Budgets,
    control: &mut impl FnMut() -> Result<()>,
) -> Result<(u32, u32)> {
    use flate2::{Decompress, FlushDecompress, Status};
    let fail = || Failure::new(Code::Media, name);
    if bytes.len() < 33 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return Err(fail());
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if w == 0 || h == 0 || bytes[24] != 8 || bytes[26..29] != [0, 0, 0] {
        return Err(fail());
    }
    let channels = match bytes[25] {
        0 => 1usize,
        2 => 3,
        4 => 2,
        6 => 4,
        _ => return Err(fail()),
    };
    let pixels = (w as usize)
        .checked_mul(h as usize)
        .ok_or_else(|| Failure::new(Code::Budget, name))?;
    let rgba = pixels
        .checked_mul(4)
        .ok_or_else(|| Failure::new(Code::Budget, name))?;
    let row = (w as usize)
        .checked_mul(channels)
        .and_then(|n| n.checked_add(1))
        .ok_or_else(|| Failure::new(Code::Budget, name))?;
    let expected = row
        .checked_mul(h as usize)
        .ok_or_else(|| Failure::new(Code::Budget, name))?;
    if pixels > limits.pixels.saturating_sub(work.pixels)
        || rgba > limits.decoded_bytes.saturating_sub(work.decoded_bytes)
        || expected > limits.work.saturating_sub(work.scanned)
    {
        return Err(Failure::new(Code::Budget, name));
    }
    work.pixels += pixels;
    work.decoded_bytes += rgba;
    // Reserve before creating the decompressor or allocating raster storage.
    let mut decoder = Decompress::new(true);
    let mut scratch = [0u8; 4096];
    let mut pos = 8;
    let mut chunks = 0;
    let mut seen_data = false;
    let mut ended = false;
    let mut seen_end = false;
    let mut seen_header = false;
    let mut idat_closed = false;
    while pos < bytes.len() {
        control()?;
        add(&mut chunks, 1, limits.nodes, name)?;
        let n = u32::from_be_bytes(
            bytes
                .get(pos..pos + 4)
                .ok_or_else(fail)?
                .try_into()
                .unwrap(),
        ) as usize;
        let end = pos
            .checked_add(12)
            .and_then(|v| v.checked_add(n))
            .filter(|v| *v <= bytes.len())
            .ok_or_else(fail)?;
        let tag = &bytes[pos + 4..pos + 8];
        let payload = &bytes[pos + 8..end - 4];
        if crc32(&bytes[pos + 4..end - 4])
            != u32::from_be_bytes(bytes[end - 4..end].try_into().unwrap())
        {
            return Err(fail());
        }
        match tag {
            b"IHDR" => {
                if seen_header || pos != 8 || n != 13 {
                    return Err(fail());
                }
                seen_header = true;
            }
            b"IDAT" => {
                if idat_closed || (ended && !payload.is_empty()) {
                    return Err(fail());
                }
                seen_data = true;
                let mut input = payload;
                loop {
                    control()?;
                    let before_in = decoder.total_in();
                    let before_out = decoder.total_out();
                    let remaining = expected
                        .saturating_sub(before_out as usize)
                        .min(limits.work.saturating_sub(work.scanned));
                    let cap = scratch.len().min(remaining.saturating_add(1));
                    work.decode_calls += 1;
                    let status = decoder
                        .decompress(input, &mut scratch[..cap], FlushDecompress::None)
                        .map_err(|_| fail())?;
                    let used = (decoder.total_in() - before_in) as usize;
                    let produced = (decoder.total_out() - before_out) as usize;
                    add(
                        &mut work.scanned,
                        produced,
                        limits.work.saturating_add(1),
                        name,
                    )?;
                    add(
                        &mut work.media_inflated,
                        produced,
                        limits.work.saturating_add(1),
                        name,
                    )?;
                    if produced > remaining {
                        return Err(Failure::new(Code::Budget, name));
                    }
                    for (i, byte) in scratch[..produced].iter().enumerate() {
                        if (before_out as usize + i) % row == 0 && *byte > 4 {
                            return Err(fail());
                        }
                    }
                    input = &input[used..];
                    if status == Status::StreamEnd {
                        ended = true;
                        if !input.is_empty() {
                            return Err(fail());
                        }
                        break;
                    }
                    if input.is_empty() && produced < cap {
                        break;
                    }
                    if used == 0 && produced == 0 {
                        return Err(fail());
                    }
                }
            }
            b"IEND" => {
                if n != 0
                    || !seen_data
                    || !ended
                    || decoder.total_out() != expected as u64
                    || end != bytes.len()
                {
                    return Err(fail());
                }
                seen_end = true;
            }
            b"PLTE" => {
                if seen_data || n == 0 || n > 768 || n % 3 != 0 {
                    return Err(fail());
                }
            }
            _ => {
                if tag[0] & 32 == 0 {
                    return Err(fail());
                }
                if seen_data {
                    idat_closed = true;
                }
            }
        }
        pos = end;
    }
    if !seen_end {
        return Err(fail());
    }
    Ok((w, h))
}
