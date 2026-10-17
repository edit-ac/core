//! Optional, fail-closed OPC ingress. No filesystem extraction, media decoder,
//! network, semantic mutation or asset publication exists at this boundary.
use crate::media::add;
pub(crate) use crate::media::validate_png;
pub use crate::media::{Budgets, Code, Failure, Work};
type Result<T> = std::result::Result<T, Failure>;
use quick_xml::{Reader, events::Event};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub part: String,
    pub code: &'static str,
}
pub(crate) fn safe_name(name: &str) -> Result<()> {
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
    pub(crate) fn part_names(&self) -> impl Iterator<Item = &str> {
        self.parts.keys().map(String::as_str)
    }
    pub(crate) fn scan_odf_xml(&mut self, control: &mut impl FnMut() -> Result<()>) -> Result<()> {
        for (name, bytes) in &self.parts {
            if name.ends_with(".xml") && name != "META-INF/manifest.xml" {
                scan_xml(
                    bytes,
                    name,
                    &mut self.work,
                    &mut self.diagnostics,
                    self.limits,
                    control,
                )?;
            }
        }
        Ok(())
    }
    pub fn work(&self) -> Work {
        self.work
    }
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    pub(crate) fn raw_part(&self, name: &str) -> Option<&[u8]> {
        self.parts.get(name).map(Vec::as_slice)
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
    pub(crate) fn charge_mapping_bytes(&mut self, count: usize) -> Result<()> {
        add(
            &mut self.work.scanned,
            count,
            self.limits.work,
            "semantic-mapping",
        )
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
    inspect_archive(bytes, limits, &mut control, true)
}
pub(crate) fn inspect_archive(
    bytes: &[u8],
    limits: Budgets,
    mut control: impl FnMut() -> Result<()>,
    opc: bool,
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
            if (opc && (name.ends_with(".xml") || name.ends_with(".rels")))
                || (!opc && name == "META-INF/manifest.xml")
            {
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
        if opc {
            validate_opc(&mut package, &mut control)?;
        }
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
