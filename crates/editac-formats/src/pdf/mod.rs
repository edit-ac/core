//! Candidate-only PDF publication policy. No reader, renderer, host font lookup,
//! filesystem or process authority enters the minimum engine. The executable
//! probe lives in tests/formats; production semantic mapping belongs to CNV-1.9.
use crate::Direction;

pub const ENGINE_VERSION: &str = "0.8.2";
pub const FONT_HASHES: [&str; 2] = [
    "b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5",
    "2f4b88e6ee50fa82c617e2d1d4ba18281cb1c6cd71c3af3ec64970c23995db4b",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unavailable {
    ExportOnly,
    Target,
    Isolation,
    ResourceLimit,
    Engine,
    Font,
    Coverage,
}

#[derive(Clone, Copy, Debug)]
pub struct Capabilities {
    pub native_macos_arm64: bool,
    pub filesystem_allowlist: bool,
    pub network_denied: bool,
    pub child_processes_denied: bool,
    pub deadline: bool,
    pub output_limit: bool,
    /// Observed-RSS watchdog; not an allocation-time or browser memory limit.
    pub rss_watchdog: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct ProbeLimits {
    pub input_bytes: usize,
    pub output_bytes: usize,
    pub deadline_ms: u64,
    pub rss_bytes: usize,
    pub pages: usize,
}

pub const PROBE_LIMITS: ProbeLimits = ProbeLimits {
    input_bytes: 64 * 1024,
    output_bytes: 4 * 1024 * 1024,
    deadline_ms: 5000,
    rss_bytes: 512 * 1024 * 1024,
    pages: 8,
};

/// Admit only a verified, tiny candidate probe. Font hashes attest the bytes
/// selected by the host, while coverage must be checked against the exact text.
/// No capability boolean is evidence that an OS actually enforced it; the
/// canonical native harness separately tests those enforcement boundaries.
pub fn admit_probe(
    direction: Direction,
    caps: Capabilities,
    limits: ProbeLimits,
    engine_version: &str,
    fonts: &[&str],
    coverage: bool,
) -> Result<(), Unavailable> {
    if direction == Direction::Import {
        return Err(Unavailable::ExportOnly);
    }
    if !caps.native_macos_arm64 {
        return Err(Unavailable::Target);
    }
    if !(caps.filesystem_allowlist && caps.network_denied && caps.child_processes_denied) {
        return Err(Unavailable::Isolation);
    }
    if !(caps.deadline && caps.output_limit && caps.rss_watchdog)
        || limits.input_bytes == 0
        || limits.input_bytes > PROBE_LIMITS.input_bytes
        || limits.output_bytes == 0
        || limits.output_bytes > PROBE_LIMITS.output_bytes
        || limits.deadline_ms == 0
        || limits.deadline_ms > PROBE_LIMITS.deadline_ms
        || limits.rss_bytes == 0
        || limits.rss_bytes > PROBE_LIMITS.rss_bytes
        || limits.pages == 0
        || limits.pages > PROBE_LIMITS.pages
    {
        return Err(Unavailable::ResourceLimit);
    }
    if engine_version != ENGINE_VERSION {
        return Err(Unavailable::Engine);
    }
    if fonts != FONT_HASHES {
        return Err(Unavailable::Font);
    }
    if !coverage {
        return Err(Unavailable::Coverage);
    }
    Ok(())
}
