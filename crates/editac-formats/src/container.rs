//! Optional, fail-closed OPC ingress. No filesystem extraction, media decoder,
//! network, semantic mutation or asset publication exists at this boundary.
use quick_xml::{Reader, events::Event};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read},
};

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
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub part: String,
    pub code: &'static str,
}
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
fn add(value: &mut usize, amount: usize, max: usize, part: &str) -> Result<()> {
    let next = value
        .checked_add(amount)
        .filter(|n| *n <= max)
        .ok_or_else(|| Failure::new(Code::Budget, part))?;
    *value = next;
    Ok(())
}
fn safe_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 1024
        || name.starts_with('/')
        || name.contains(['\\', ':', '%', '?', '#'])
        || name.chars().any(|c| c.is_control() || !c.is_ascii())
        || name
            .trim_end_matches('/')
            .split('/')
            .any(|c| c.is_empty() || c == "." || c == ".." || c.ends_with([' ', '.']))
    {
        return Err(Failure::new(Code::Path, name));
    }
    Ok(())
}
fn u16le(b: &[u8], p: usize) -> Result<usize> {
    Ok(u16::from_le_bytes(
        b.get(p..p + 2)
            .ok_or_else(|| Failure::new(Code::Archive, ""))?
            .try_into()
            .unwrap(),
    ) as usize)
}
fn u32le(b: &[u8], p: usize) -> Result<usize> {
    Ok(u32::from_le_bytes(
        b.get(p..p + 4)
            .ok_or_else(|| Failure::new(Code::Archive, ""))?
            .try_into()
            .unwrap(),
    ) as usize)
}
/// Bound metadata before ZIP's own allocations. This profile rejects ZIP64,
/// multi-disk, prepended/trailing payloads and local/central name disagreement.
fn preflight(b: &[u8], limits: Budgets, control: &mut impl FnMut() -> Result<()>) -> Result<usize> {
    if b.len() > limits.input || b.len() < 22 {
        return Err(Failure::new(Code::Budget, ""));
    }
    let start = b.len().saturating_sub(65557);
    let end = (start..=b.len() - 22)
        .rev()
        .find(|p| {
            b[*p..].starts_with(b"PK\x05\x06")
                && u16le(b, *p + 20).is_ok_and(|n| *p + 22 + n == b.len())
        })
        .ok_or_else(|| Failure::new(Code::Archive, ""))?;
    let count = u16le(b, end + 10)?;
    if count == 0 || count > limits.entries {
        return Err(Failure::new(Code::Budget, ""));
    }
    if u16le(b, end + 4)? != 0 || u16le(b, end + 6)? != 0 || u16le(b, end + 8)? != count {
        return Err(Failure::new(Code::Archive, ""));
    }
    let mut pos = u32le(b, end + 16)?;
    if pos.checked_add(u32le(b, end + 12)?) != Some(end) || !b.starts_with(b"PK\x03\x04") {
        return Err(Failure::new(Code::Archive, ""));
    }
    let directory_start = pos;
    let mut ranges = Vec::new();
    let mut names = BTreeSet::new();
    let mut offsets = BTreeSet::new();
    for _ in 0..count {
        control()?;
        if !b.get(pos..).is_some_and(|s| s.starts_with(b"PK\x01\x02")) {
            return Err(Failure::new(Code::Archive, ""));
        }
        let len = u16le(b, pos + 28)?;
        if len > 1024 {
            return Err(Failure::new(Code::Path, ""));
        }
        let name = std::str::from_utf8(
            b.get(pos + 46..pos + 46 + len)
                .ok_or_else(|| Failure::new(Code::Archive, ""))?,
        )
        .map_err(|_| Failure::new(Code::Encoding, ""))?;
        safe_name(name)?;
        let canonical = name.trim_end_matches('/').to_ascii_lowercase();
        if !names.insert(canonical.clone()) {
            return Err(Failure::new(Code::Duplicate, name));
        }
        let flags = u16le(b, pos + 8)?;
        if flags & (1 | 64 | 8192) != 0 {
            return Err(Failure::new(Code::Encryption, name));
        }
        let method = u16le(b, pos + 10)?;
        if ![0, 8].contains(&method) {
            return Err(Failure::new(Code::Archive, name));
        }
        let mode = u32le(b, pos + 38)? >> 16;
        if mode & 0o170000 == 0o120000 {
            return Err(Failure::new(Code::Symlink, name));
        }
        let offset = u32le(b, pos + 42)?;
        if !offsets.insert(offset)
            || !b
                .get(offset..)
                .is_some_and(|s| s.starts_with(b"PK\x03\x04"))
            || u16le(b, offset + 6)? != flags
            || u16le(b, offset + 8)? != method
            || u16le(b, offset + 26)? != len
            || b.get(offset + 30..offset + 30 + len) != Some(name.as_bytes())
        {
            return Err(Failure::new(Code::Archive, name));
        }
        let compressed = u32le(b, pos + 20)?;
        let local_extra = u16le(b, offset + 28)?;
        let data_start = offset
            .checked_add(30 + len + local_extra)
            .ok_or_else(|| Failure::new(Code::Archive, name))?;
        let mut data_end = data_start
            .checked_add(compressed)
            .filter(|n| *n <= directory_start)
            .ok_or_else(|| Failure::new(Code::Archive, name))?;
        if flags & 8 == 0 {
            for delta in [14, 18, 22] {
                let central_delta = match delta {
                    14 => 16,
                    18 => 20,
                    _ => 24,
                };
                if u32le(b, offset + delta)? != u32le(b, pos + central_delta)? {
                    return Err(Failure::new(Code::Archive, name));
                }
            }
        } else {
            let descriptor = data_end;
            let skip = if b
                .get(descriptor..)
                .is_some_and(|s| s.starts_with(b"PK\x07\x08"))
            {
                4
            } else {
                0
            };
            for (delta, central_delta) in [(0, 16), (4, 20), (8, 24)] {
                if u32le(b, descriptor + skip + delta)? != u32le(b, pos + central_delta)? {
                    return Err(Failure::new(Code::Archive, name));
                }
            }
            data_end = data_end
                .checked_add(skip + 12)
                .filter(|n| *n <= directory_start)
                .ok_or_else(|| Failure::new(Code::Archive, name))?;
        }
        ranges.push((offset, data_end));
        // Reject ZIP64 records/sizes rather than handing unbounded metadata to the codec.
        if u32le(b, pos + 20)? == u32::MAX as usize
            || u32le(b, pos + 24)? == u32::MAX as usize
            || u16le(b, pos + 34)? != 0
        {
            return Err(Failure::new(Code::Archive, name));
        }
        pos = pos
            .checked_add(46 + len + u16le(b, pos + 30)? + u16le(b, pos + 32)?)
            .filter(|p| *p <= end)
            .ok_or_else(|| Failure::new(Code::Archive, name))?;
    }
    if pos != end {
        return Err(Failure::new(Code::Archive, ""));
    }
    ranges.sort_unstable();
    let mut covered = 0;
    for (start, end) in ranges {
        if start != covered || end < start {
            return Err(Failure::new(
                Code::Archive,
                "overlapping-or-hidden-local-entry",
            ));
        }
        covered = end;
    }
    if covered != directory_start {
        return Err(Failure::new(Code::Archive, "unreferenced-local-data"));
    }
    for name in &names {
        let mut ancestor = name.as_str();
        while let Some((parent, _)) = ancestor.rsplit_once('/') {
            // Explicit directory entries are intentionally unsupported to avoid
            // file/directory shadowing and platform-dependent normalization.
            if names.contains(parent) {
                return Err(Failure::new(Code::Duplicate, name));
            }
            ancestor = parent;
        }
    }
    Ok(count)
}
#[derive(Debug)]
pub struct Package {
    parts: BTreeMap<String, Vec<u8>>,
    diagnostics: Vec<Diagnostic>,
    work: Work,
    limits: Budgets,
    rejected: BTreeMap<String, Failure>,
    admitted_media: BTreeSet<String>,
    pub(crate) job_token: Option<std::sync::Arc<()>>,
}
impl Package {
    pub fn work(&self) -> Work {
        self.work
    }
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    pub fn part(&self, name: &str) -> Option<&[u8]> {
        if !name.ends_with(".xml")
            && !name.ends_with(".rels")
            && !self.admitted_media.contains(name)
        {
            return None;
        }
        self.parts.get(name).map(Vec::as_slice)
    }
    /// Charge every reference, including cache hits. Failed expensive media
    /// checks are cached only inside this immutable package/job instance.
    pub fn media(
        &mut self,
        name: &str,
        control: &mut impl FnMut() -> Result<()>,
    ) -> Result<(u32, u32)> {
        self.media_inner(name, control).map_err(|mut failure| {
            failure.work = self.work;
            failure
        })
    }
    fn media_inner(
        &mut self,
        name: &str,
        control: &mut impl FnMut() -> Result<()>,
    ) -> Result<(u32, u32)> {
        control()?;
        safe_name(name)?;
        add(&mut self.work.references, 1, self.limits.nodes, name)?;
        if let Some(e) = self.rejected.get(name) {
            let mut error = e.clone();
            error.work = self.work;
            return Err(error);
        }
        let bytes = self
            .parts
            .get(name)
            .ok_or_else(|| Failure::new(Code::Relationship, name))?;
        add(&mut self.work.scanned, bytes.len(), self.limits.work, name)?;
        self.work.media_attempts += 1;
        let mut result = validate_png(bytes, name, &mut self.work, self.limits, control);
        if let Err(error) = &mut result {
            error.work = self.work;
        }
        if result.is_ok() {
            self.admitted_media.insert(name.into());
        }
        if let Err(e) = &result {
            self.rejected.insert(name.into(), e.clone());
        }
        result
    }
    pub fn charge_output_nodes(&mut self, count: usize) -> Result<()> {
        add(
            &mut self.work.nodes,
            count,
            self.limits.nodes,
            "semantic-output",
        )
    }
}
/// Only validated package bytes become visible. On failure the caller retains
/// original bytes, and must abort its PreparedJob (see prepare_container).
pub fn inspect(
    bytes: &[u8],
    limits: Budgets,
    mut control: impl FnMut() -> Result<()>,
) -> Result<Package> {
    control()?;
    let cap = Budgets::default();
    if [
        (limits.input, cap.input),
        (limits.entries, cap.entries),
        (limits.part, cap.part),
        (limits.inflated, cap.inflated),
        (limits.ratio, cap.ratio),
        (limits.depth, cap.depth),
        (limits.attributes, cap.attributes),
        (limits.text, cap.text),
        (limits.nodes, cap.nodes),
        (limits.work, cap.work),
        (limits.pixels, cap.pixels),
        (limits.decoded_bytes, cap.decoded_bytes),
    ]
    .iter()
    .any(|(requested, qualified)| requested > qualified)
    {
        return Err(Failure::new(Code::Budget, "unqualified-profile-limits"));
    }
    let count = preflight(bytes, limits, &mut control)?;
    let mut zip =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| Failure::new(Code::Archive, ""))?;
    if zip.len() != count {
        return Err(Failure::new(Code::Duplicate, ""));
    }
    let mut package = Package {
        parts: BTreeMap::new(),
        diagnostics: vec![],
        work: Work::default(),
        limits,
        rejected: BTreeMap::new(),
        admitted_media: BTreeSet::new(),
        job_token: None,
    };
    let result = (|| {
        for i in 0..zip.len() {
            control()?;
            let mut file = zip
                .by_index(i)
                .map_err(|_| Failure::new(Code::Archive, ""))?;
            let name = file.name().to_owned();
            if file.encrypted() {
                return Err(Failure::new(Code::Encryption, &name));
            }
            if file.is_symlink() {
                return Err(Failure::new(Code::Symlink, &name));
            }
            if file.is_dir() {
                return Err(Failure::new(Code::Path, &name));
            }
            let compressed = usize::try_from(file.compressed_size())
                .map_err(|_| Failure::new(Code::Budget, &name))?;
            let ratio_limit = compressed
                .checked_mul(limits.ratio)
                .ok_or_else(|| Failure::new(Code::Budget, &name))?;
            let mut part = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                control()?;
                let remaining = limits
                    .part
                    .saturating_sub(part.len())
                    .min(limits.inflated.saturating_sub(package.work.inflated))
                    .min(ratio_limit.saturating_sub(part.len()))
                    .min(limits.work.saturating_sub(package.work.scanned));
                // Read one bounded sentinel byte to distinguish exact-limit EOF.
                let max = chunk.len().min(remaining.saturating_add(1));
                let n = file
                    .read(&mut chunk[..max])
                    .map_err(|_| Failure::new(Code::Archive, &name))?;
                if n == 0 {
                    break;
                }
                // Observe the bounded sentinel read even when it proves exhaustion.
                add(
                    &mut package.work.inflated,
                    n,
                    limits.inflated.saturating_add(1),
                    &name,
                )?;
                add(
                    &mut package.work.scanned,
                    n,
                    limits.work.saturating_add(1),
                    &name,
                )?;
                if n > remaining {
                    return Err(Failure::new(Code::Budget, &name));
                }
                part.extend_from_slice(&chunk[..n]);
            }
            if part.len() as u64 != file.size() {
                return Err(Failure::new(Code::Archive, &name));
            }
            package.work.entries += 1;
            if part.starts_with(b"PK\x03\x04") || part.starts_with(b"PK\x05\x06") {
                return Err(Failure::new(Code::NestedPackage, &name));
            }
            if name.ends_with(".xml") || name.ends_with(".rels") {
                scan_xml(
                    &part,
                    &name,
                    &mut package.work,
                    &mut package.diagnostics,
                    limits,
                    &mut control,
                )?;
            }
            package.parts.insert(name, part);
        }
        validate_opc(&mut package, &mut control)?;
        Ok(())
    })();
    match result {
        Ok(()) => Ok(package),
        Err(mut failure) => {
            failure.work = package.work;
            Err(failure)
        }
    }
}
fn xml_chars(text: &str, name: &str) -> Result<()> {
    if text
        .chars()
        .any(|c| !matches!(c as u32, 0x9|0xa|0xd|0x20..=0xd7ff|0xe000..=0xfffd|0x10000..=0x10ffff))
    {
        return Err(Failure::new(Code::Xml, name));
    }
    Ok(())
}
fn scan_xml(
    bytes: &[u8],
    name: &str,
    work: &mut Work,
    diagnostics: &mut Vec<Diagnostic>,
    limits: Budgets,
    control: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
    // Decode policy is deliberately UTF-8 only, never lossy replacement.
    let text = std::str::from_utf8(bytes).map_err(|_| Failure::new(Code::Encoding, name))?;
    if text
        .chars()
        .any(|c| c == '\0' || (c < ' ' && !['\t', '\n', '\r'].contains(&c)))
    {
        return Err(Failure::new(Code::Encoding, name));
    }
    xml_chars(text, name)?;
    let mut reader = Reader::from_str(text);
    reader.config_mut().check_comments = true;
    let mut depth = 0usize;
    let mut roots = 0;
    let mut declared = false;
    loop {
        control()?;
        let before = reader.buffer_position();
        let event = reader
            .read_event()
            .map_err(|_| Failure::new(Code::Xml, name))?;
        add(
            &mut work.scanned,
            (reader.buffer_position() - before) as usize,
            limits.work,
            name,
        )?;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                if depth == 0 {
                    roots += 1;
                }
                let active = match e.local_name().as_ref() {
                    b"altChunk" => Some("ALTCHUNK_INERT"),
                    b"object" | b"OLEObject" | b"oleObject" => Some("OLE_OBJECT_INERT"),
                    b"attachedTemplate" => Some("TEMPLATE_INERT"),
                    b"control" => Some("CONTENT_CONTROL_INERT"),
                    _ => None,
                };
                if let Some(code) = active {
                    diagnostics.push(Diagnostic {
                        part: name.into(),
                        code,
                    });
                }
                if depth >= limits.depth {
                    return Err(Failure::new(Code::Budget, name));
                }
                add(&mut work.nodes, 1, limits.nodes, name)?;
                let mut n = 0;
                for a in e.attributes() {
                    add(&mut n, 1, limits.attributes, name)?;
                    let a = a.map_err(|_| Failure::new(Code::Xml, name))?;
                    add(&mut work.text, a.value.len(), limits.text, name)?;
                    if a.value.contains(&b'<') {
                        return Err(Failure::new(Code::Xml, name));
                    }
                    let decoded = a
                        .decoded_and_normalized_value(
                            quick_xml::XmlVersion::Implicit1_0,
                            Reader::from_str("").decoder(),
                        )
                        .map_err(|_| Failure::new(Code::Xml, name))?;
                    xml_chars(&decoded, name)?;
                }
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                }
            }
            Event::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| Failure::new(Code::Xml, name))?;
            }
            Event::DocType(_) => return Err(Failure::new(Code::Dtd, name)),
            Event::Decl(e) => {
                if declared
                    || roots != 0
                    || e.version()
                        .map_err(|_| Failure::new(Code::Xml, name))?
                        .as_ref()
                        != b"1.0"
                {
                    return Err(Failure::new(Code::Xml, name));
                }
                declared = true;
                if e.encoding()
                    .transpose()
                    .map_err(|_| Failure::new(Code::Xml, name))?
                    .is_some_and(|v| !v.eq_ignore_ascii_case(b"utf-8"))
                {
                    return Err(Failure::new(Code::Encoding, name));
                }
            }
            Event::Text(e) => {
                let raw = e.decode().map_err(|_| Failure::new(Code::Encoding, name))?;
                let decoded =
                    quick_xml::escape::unescape(&raw).map_err(|_| Failure::new(Code::Xml, name))?;
                xml_chars(&decoded, name)?;
                if depth == 0 && !raw.trim().is_empty() {
                    return Err(Failure::new(Code::Xml, name));
                }
                add(&mut work.text, e.len(), limits.text, name)?;
            }
            Event::CData(e) => {
                if depth == 0 {
                    return Err(Failure::new(Code::Xml, name));
                }
                add(&mut work.text, e.len(), limits.text, name)?;
            }
            Event::GeneralRef(e) => {
                // quick-xml emits entity references separately. Only predefined
                // entities and valid numeric references are admitted.
                let raw = format!(
                    "&{};",
                    std::str::from_utf8(e.as_ref())
                        .map_err(|_| Failure::new(Code::Encoding, name))?
                );
                let decoded =
                    quick_xml::escape::unescape(&raw).map_err(|_| Failure::new(Code::Xml, name))?;
                xml_chars(&decoded, name)?;
                if depth == 0 {
                    return Err(Failure::new(Code::Xml, name));
                }
                add(&mut work.text, raw.len(), limits.text, name)?;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if roots != 1 || depth != 0 {
        return Err(Failure::new(Code::Xml, name));
    }
    Ok(())
}
fn attrs(e: &quick_xml::events::BytesStart<'_>, name: &str) -> Result<BTreeMap<String, String>> {
    e.attributes()
        .map(|a| {
            let a = a.map_err(|_| Failure::new(Code::Xml, name))?;
            Ok((
                std::str::from_utf8(a.key.as_ref())
                    .map_err(|_| Failure::new(Code::Encoding, name))?
                    .into(),
                a.decoded_and_normalized_value(
                    quick_xml::XmlVersion::Implicit1_0,
                    Reader::from_str("").decoder(),
                )
                .map_err(|_| Failure::new(Code::Xml, name))?
                .into_owned(),
            ))
        })
        .collect()
}
fn required<'a>(
    a: &'a BTreeMap<String, String>,
    key: &str,
    code: Code,
    name: &str,
) -> Result<&'a str> {
    a.get(key)
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Failure::new(code, name))
}
fn valid_mime(value: &str) -> bool {
    value.len() <= 127
        && value.split_once('/').is_some_and(|(a, b)| {
            !a.is_empty()
                && !b.is_empty()
                && a.bytes()
                    .chain(b.bytes())
                    .all(|c| c.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&c))
        })
}
fn validate_opc(p: &mut Package, control: &mut impl FnMut() -> Result<()>) -> Result<()> {
    let ct = p
        .parts
        .get("[Content_Types].xml")
        .ok_or_else(|| Failure::new(Code::ContentType, "[Content_Types].xml"))?;
    add(
        &mut p.work.scanned,
        ct.len(),
        p.limits.work,
        "[Content_Types].xml",
    )?;
    let mut defaults = BTreeMap::new();
    let mut overrides = BTreeMap::new();
    let mut reader = Reader::from_reader(ct.as_slice());
    let mut root = false;
    loop {
        control()?;
        match reader
            .read_event()
            .map_err(|_| Failure::new(Code::Xml, "[Content_Types].xml"))?
        {
            Event::Start(e) | Event::Empty(e) => {
                let a = attrs(&e, "[Content_Types].xml")?;
                match e.name().as_ref() {
                    b"Types" => {
                        if root || a.keys().any(|k| k != "xmlns") {
                            return Err(Failure::new(Code::ContentType, "[Content_Types].xml"));
                        }
                        root = a.get("xmlns").is_some_and(|s| {
                            s == "http://schemas.openxmlformats.org/package/2006/content-types"
                        });
                    }
                    b"Default" => {
                        let ext =
                            required(&a, "Extension", Code::ContentType, "[Content_Types].xml")?;
                        let ty = required(&a, "ContentType", Code::ContentType, ext)?;
                        if !valid_mime(ty)
                            || a.keys()
                                .any(|k| !["Extension", "ContentType"].contains(&k.as_str()))
                        {
                            return Err(Failure::new(Code::ContentType, ext));
                        }
                        if ext.contains(['/', '.', '\\'])
                            || defaults.insert(ext.to_owned(), ty.to_owned()).is_some()
                        {
                            return Err(Failure::new(Code::ContentType, ext));
                        }
                    }
                    b"Override" => {
                        let name =
                            required(&a, "PartName", Code::ContentType, "[Content_Types].xml")?;
                        let key = name
                            .strip_prefix('/')
                            .ok_or_else(|| Failure::new(Code::ContentType, name))?;
                        safe_name(key)?;
                        let ty = required(&a, "ContentType", Code::ContentType, name)?;
                        if !valid_mime(ty)
                            || a.keys()
                                .any(|k| !["PartName", "ContentType"].contains(&k.as_str()))
                        {
                            return Err(Failure::new(Code::ContentType, name));
                        }
                        if !p.parts.contains_key(key)
                            || overrides.insert(key.to_owned(), ty.to_owned()).is_some()
                        {
                            return Err(Failure::new(Code::ContentType, name));
                        }
                    }
                    _ => return Err(Failure::new(Code::ContentType, "[Content_Types].xml")),
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !root {
        return Err(Failure::new(Code::ContentType, "[Content_Types].xml"));
    }
    let mut quarantine = BTreeSet::new();
    for (name, bytes) in &p.parts {
        control()?;
        if name == "[Content_Types].xml" {
            continue;
        }
        let ty = overrides
            .get(name)
            .or_else(|| name.rsplit_once('.').and_then(|(_, ext)| defaults.get(ext)))
            .ok_or_else(|| Failure::new(Code::ContentType, name))?;
        let lower = ty.to_ascii_lowercase();
        if lower.contains("macro")
            || lower.contains("oleobject")
            || name.to_ascii_lowercase().contains("vbaproject")
            || name.contains("embeddings/")
            || lower.contains("html")
        {
            p.diagnostics.push(Diagnostic {
                part: name.clone(),
                code: "ACTIVE_PART_INERT",
            });
            quarantine.insert(name.clone());
        }
        if !lower.ends_with("xml") && lower != "image/png" && !quarantine.contains(name) {
            p.diagnostics.push(Diagnostic {
                part: name.clone(),
                code: "UNSUPPORTED_PART_INERT",
            });
            quarantine.insert(name.clone());
        }
        if (name.ends_with(".xml") && !lower.ends_with("xml"))
            || (name.ends_with(".rels")
                && lower != "application/vnd.openxmlformats-package.relationships+xml")
            || (bytes.starts_with(b"\x89PNG") && lower != "image/png")
        {
            return Err(Failure::new(Code::ContentType, name));
        }
        if !name.ends_with(".rels") {
            continue;
        }
        add(&mut p.work.scanned, bytes.len(), p.limits.work, name)?;
        let base = if name == "_rels/.rels" {
            ""
        } else {
            let (dir, _) = name
                .rsplit_once("/_rels/")
                .ok_or_else(|| Failure::new(Code::Relationship, name))?;
            dir
        };
        let mut reader = Reader::from_reader(bytes.as_slice());
        let mut ids = BTreeSet::new();
        let mut root = false;
        loop {
            control()?;
            match reader
                .read_event()
                .map_err(|_| Failure::new(Code::Relationship, name))?
            {
                Event::Start(e) | Event::Empty(e) => {
                    let a = attrs(&e, name)?;
                    match e.name().as_ref() {
                        b"Relationships" => {
                            if root || a.keys().any(|k| k != "xmlns") {
                                return Err(Failure::new(Code::Relationship, name));
                            }
                            root = a.get("xmlns").is_some_and(|v| {
                                v == "http://schemas.openxmlformats.org/package/2006/relationships"
                            });
                        }
                        b"Relationship" => {
                            add(&mut p.work.references, 1, p.limits.nodes, name)?;
                            if a.keys().any(|k| {
                                !["Id", "Type", "Target", "TargetMode"].contains(&k.as_str())
                            }) {
                                return Err(Failure::new(Code::Relationship, name));
                            }
                            let id = required(&a, "Id", Code::Relationship, name)?;
                            if !ids.insert(id.to_owned()) {
                                return Err(Failure::new(Code::Relationship, name));
                            }
                            let target = required(&a, "Target", Code::Relationship, name)?;
                            let ty = required(&a, "Type", Code::Relationship, name)?;
                            if id.len() > 256
                                || target.len() > 1024
                                || ty.len() > 1024
                                || !ty.contains(':')
                                || ty.chars().any(|c| c.is_control() || c.is_whitespace())
                            {
                                return Err(Failure::new(Code::Relationship, name));
                            }
                            if let Some(mode) = a.get("TargetMode") {
                                if mode != "External" && mode != "Internal" {
                                    return Err(Failure::new(Code::Relationship, name));
                                }
                                if mode == "External" {
                                    p.diagnostics.push(Diagnostic {
                                        part: format!("{name}#{id}"),
                                        code: "EXTERNAL_RELATIONSHIP_INERT",
                                    });
                                    continue;
                                }
                            }
                            let path = if let Some(t) = target.strip_prefix('/') {
                                safe_name(t)?;
                                t.to_owned()
                            } else {
                                safe_name(target)?;
                                if base.is_empty() {
                                    target.to_owned()
                                } else {
                                    format!("{base}/{target}")
                                }
                            };
                            if !p.parts.contains_key(&path) {
                                return Err(Failure::new(Code::Relationship, &path));
                            }
                            if [
                                "/oleObject",
                                "/package",
                                "/aFChunk",
                                "/attachedTemplate",
                                "/vbaProject",
                            ]
                            .iter()
                            .any(|suffix| ty.ends_with(suffix))
                            {
                                quarantine.insert(path.clone());
                                p.diagnostics.push(Diagnostic {
                                    part: path,
                                    code: "ACTIVE_RELATIONSHIP_INERT",
                                });
                            }
                        }
                        _ => return Err(Failure::new(Code::Relationship, name)),
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
        if !root {
            return Err(Failure::new(Code::Relationship, name));
        }
    }
    for name in quarantine {
        p.parts.remove(&name);
    }
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
fn validate_png(
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
