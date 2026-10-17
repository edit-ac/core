//! Local directional admission and complete-output contracts. This registry does
//! not convert documents, write a Session, fetch resources, or publish a file.
//! Baseline formats continue through their existing shared adapters.

#[cfg(any(feature = "container-codecs", feature = "pdf-export"))]
mod media;

#[cfg(feature = "container-codecs")]
pub mod container;

#[cfg(feature = "jobs")]
pub mod job;

#[cfg(feature = "pdf-probe")]
pub mod pdf;

#[cfg(all(feature = "docx-codecs", feature = "jobs"))]
pub mod docx;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Import,
    Export,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub input_bytes: usize,
    pub output_bytes: usize,
    pub nodes: usize,
    pub pages: usize,
}

pub const LIMITS: Limits = Limits {
    input_bytes: 1024 * 1024,
    output_bytes: 4 * 1024 * 1024,
    nodes: 4096,
    pages: 256,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Profile {
    pub id: &'static str,
    pub format: &'static str,
    pub version: u32,
    pub import: bool,
    pub export: bool,
    /// `false` means the direction is planned, not an installed converter.
    pub available: bool,
    pub fidelity: &'static str,
    pub owner: &'static str,
    pub limits: Limits,
}

macro_rules! profile {
    ($format:literal, $import:literal, $fidelity:literal, $owner:literal) => {
        Profile {
            id: concat!("edit-ac-", $format, "-v1"),
            format: $format,
            version: 1,
            import: $import,
            export: true,
            available: false,
            fidelity: $fidelity,
            owner: $owner,
            limits: LIMITS,
        }
    };
}

pub const PROFILES: &[Profile] = &[
    profile!("docx", true, "semantic-subset", "CNV-1.3–1.7"),
    profile!("pdf", false, "publication", "CNV-1.8–1.9"),
    profile!("odt", true, "semantic-subset", "CNV-1.10–1.11"),
    profile!("rtf", true, "bounded-rich-text", "CNV-1.12–1.13"),
    profile!("epub", true, "reflowable-publication", "CNV-1.14–1.15"),
    profile!("csv", true, "selected-table-text", "CNV-1.16–1.17"),
    profile!("tsv", true, "selected-table-text", "CNV-1.16–1.17"),
];

pub fn profile(id: &str) -> Option<&'static Profile> {
    PROFILES.iter().find(|p| p.id == id)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    ExportOnly,
    UnsupportedFormat,
    DirectionUnavailable,
    AdapterUnavailable,
    InputLimit,
    OutputLimit,
}

impl Code {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ExportOnly => "FORMAT_EXPORT_ONLY",
            Self::UnsupportedFormat => "FORMAT_UNSUPPORTED",
            Self::DirectionUnavailable => "FORMAT_DIRECTION_UNAVAILABLE",
            Self::AdapterUnavailable => "FORMAT_ADAPTER_UNAVAILABLE",
            Self::InputLimit => "FORMAT_INPUT_LIMIT",
            Self::OutputLimit => "FORMAT_OUTPUT_LIMIT",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub schema_version: u32,
    pub code: Code,
    pub message: &'static str,
    pub action: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure<'a> {
    pub diagnostic: Diagnostic,
    /// Borrowed original bytes remain caller-owned; failure never discards them.
    pub original: &'a [u8],
}

fn failure(original: &[u8], code: Code) -> Failure<'_> {
    let (message, action) = match code {
        Code::ExportOnly => (
            "PDF is export-only.",
            "Open the editable authoring source; retain this PDF as a file.",
        ),
        Code::UnsupportedFormat => (
            "Format/profile is unsupported.",
            "Choose a declared supported format; retain the original input.",
        ),
        Code::DirectionUnavailable => (
            "This profile does not support the requested direction.",
            "Choose an available Save As/export profile; retain input and edits.",
        ),
        Code::AdapterUnavailable => (
            "The optional converter is not installed or qualified.",
            "Enable a qualified local adapter; retain input and edits.",
        ),
        Code::InputLimit => (
            "Input exceeds this profile's limit.",
            "Choose a smaller input or an explicitly qualified larger profile.",
        ),
        Code::OutputLimit => (
            "Output is incomplete: a resource limit was exceeded.",
            "Retain input and edits; choose a qualified larger profile or explicit smaller selection.",
        ),
    };
    Failure {
        diagnostic: Diagnostic {
            schema_version: 1,
            code,
            message,
            action,
        },
        original,
    }
}

pub struct ImportRequest<'a> {
    pub profile_id: &'a str,
    pub filename: &'a str,
    pub media_type: &'a str,
    pub original: &'a [u8],
}

/// Conservative bounded recognition: *any* PDF hint rejects editable import,
/// regardless of the selected profile or misleading extension/MIME.
pub fn admit_import<'a>(request: &ImportRequest<'a>) -> Result<&'static Profile, Failure<'a>> {
    let mime = request.media_type.split(';').next().unwrap_or("").trim();
    let filename_pdf = request
        .filename
        .trim_end()
        .rsplit('.')
        .next()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"));
    let signature_pdf = request.original[..request.original.len().min(1024)]
        .windows(5)
        .any(|w| w == b"%PDF-");
    if request.profile_id == "edit-ac-pdf-v1"
        || filename_pdf
        || mime.eq_ignore_ascii_case("application/pdf")
        || signature_pdf
    {
        return Err(failure(request.original, Code::ExportOnly));
    }
    let p = profile(request.profile_id)
        .ok_or_else(|| failure(request.original, Code::UnsupportedFormat))?;
    admit_direction(p, Direction::Import, request.original)?;
    Ok(p)
}

pub fn admit_direction<'a>(
    p: &Profile,
    direction: Direction,
    original: &'a [u8],
) -> Result<(), Failure<'a>> {
    if direction == Direction::Import && p.format == "pdf" {
        return Err(failure(original, Code::ExportOnly));
    }
    if !(match direction {
        Direction::Import => p.import,
        Direction::Export => p.export,
    }) {
        return Err(failure(original, Code::DirectionUnavailable));
    }
    if original.len() > p.limits.input_bytes {
        return Err(failure(original, Code::InputLimit));
    }
    if !p.available {
        return Err(failure(original, Code::AdapterUnavailable));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Work {
    pub bytes: usize,
    pub nodes: usize,
    pub pages: usize,
}

/// Only `finish` exposes bytes. A rejected append poisons the builder, so a
/// caller cannot ignore a failure and publish the successful prefix as complete.
pub struct Output<'a> {
    original: &'a [u8],
    revision: &'a str,
    limits: Limits,
    work: Work,
    bytes: Vec<u8>,
    failed: bool,
}

/// A complete result can only be obtained from the checked output boundary.
///
/// ```compile_fail
/// use editac_formats::{CompleteArtifact, Work};
/// let forged = CompleteArtifact {
///     revision: "N", bytes: b"truncated".to_vec(), work: Work::default(),
/// };
/// ```
#[derive(Debug, PartialEq, Eq)]
pub struct CompleteArtifact<'a> {
    revision: &'a str,
    bytes: Vec<u8>,
    work: Work,
}

impl<'a> CompleteArtifact<'a> {
    pub fn revision(&self) -> &'a str {
        self.revision
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn work(&self) -> Work {
        self.work
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

impl<'a> Output<'a> {
    pub fn begin(p: &Profile, original: &'a [u8], revision: &'a str) -> Result<Self, Failure<'a>> {
        admit_direction(p, Direction::Export, original)?;
        Ok(Self {
            original,
            revision,
            limits: p.limits,
            work: Work::default(),
            bytes: Vec::new(),
            failed: false,
        })
    }

    pub fn append(&mut self, bytes: &[u8], nodes: usize, pages: usize) -> Result<(), Failure<'a>> {
        let next = self
            .work
            .bytes
            .checked_add(bytes.len())
            .zip(self.work.nodes.checked_add(nodes))
            .zip(self.work.pages.checked_add(pages));
        let allowed = next.is_some_and(|((b, n), p)| {
            b <= self.limits.output_bytes && n <= self.limits.nodes && p <= self.limits.pages
        });
        if self.failed || !allowed {
            self.failed = true;
            self.bytes = Vec::new();
            return Err(failure(self.original, Code::OutputLimit));
        }
        let ((bytes_count, nodes), pages) = next.unwrap();
        self.work = Work {
            bytes: bytes_count,
            nodes,
            pages,
        };
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    pub fn finish(self) -> Result<CompleteArtifact<'a>, Failure<'a>> {
        if self.failed {
            return Err(failure(self.original, Code::OutputLimit));
        }
        Ok(CompleteArtifact {
            revision: self.revision,
            bytes: self.bytes,
            work: self.work,
        })
    }
}

#[cfg(any(feature = "odt-import", feature = "odt-export"))]
pub mod odt;
