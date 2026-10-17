//! Direct numbering, simple rectangular tables and paragraph-isolated PNG assets.
//! Uses only shared list/content descriptors. No inline tuple transfer or layout.
use super::*;
use editac_core::{
    commands::lists::ContainerStyle,
    modules::{
        assets::*,
        content::{Alignment, Content},
    },
};
use editac_session::{
    assets::{AssetHost, HostOutcome},
    ports::PortError,
};
use sha2::{Digest, Sha256};

pub const STRUCTURE_PROFILE: crate::Profile = crate::Profile {
    fidelity: "docx-structure-semantic-v1",
    owner: "CNV-1.6",
    ..TEXT_PROFILE
};
const NUM: &str = "word/numbering.xml";
const WP: &str = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";
/// Prepared host transport. Identity selection must be pure and stable by digest.
/// Bytes reach ingest only after guarded decode and a durable job-owned intent.
/// Hosts implement the normal AssetHost cancellation/release fencing as well.
pub trait OriginalMediaHost: AssetHost {
    fn identity(&self, sha256: &[u8; 32]) -> std::result::Result<AssetIdentity, PortError>;
    fn ingest_original(
        &mut self,
        reference: &str,
        request: &AssetRequest,
        bytes: &[u8],
    ) -> std::result::Result<HostOutcome, PortError>;
}
struct Media<'a, H> {
    host: &'a mut H,
    bytes: &'a [u8],
}
impl<H: OriginalMediaHost> AssetHost for Media<'_, H> {
    fn authorize(&mut self, r: &AssetRequest) -> std::result::Result<AssetGrant, PortError> {
        self.host.authorize(r)
    }
    fn execute(
        &mut self,
        id: &str,
        r: &AssetRequest,
    ) -> std::result::Result<HostOutcome, PortError> {
        if r.action == AssetAction::Ingest {
            self.host.ingest_original(id, r, self.bytes)
        } else {
            self.host.execute(id, r)
        }
    }
}
fn descendants<'a>(n: &'a Node, ns: &str, name: &str, out: &mut Vec<&'a Node>) {
    if n.ns == ns && n.name == name {
        out.push(n)
    }
    for c in &n.children {
        descendants(c, ns, name, out)
    }
}
fn find<'a>(n: &'a Node, ns: &str, name: &str) -> Result<Option<&'a Node>> {
    let mut nodes = vec![];
    descendants(n, ns, name, &mut nodes);
    if nodes.len() > 1 {
        return Err(fail(Code::Profile, &n.location));
    }
    Ok(nodes.into_iter().next())
}
fn integer(n: Option<&Node>, max: u32) -> Result<u32> {
    if n.is_some_and(|n| !n.children.is_empty() || !n.text.trim().is_empty()) {
        return Err(fail(Code::Profile, "numbering-scalar-content"));
    }
    n.and_then(Node::val)
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|v| *v <= max)
        .ok_or_else(|| fail(Code::Profile, "numbering-integer"))
}
#[derive(Clone)]
struct Level {
    style: ContainerStyle,
}
#[derive(Default)]
struct Numbering {
    definitions: BTreeMap<u32, Vec<Option<Level>>>,
    active: Vec<(u32, usize, String, ContainerStyle)>,
    counters: BTreeMap<(u32, usize), u32>,
    serial: usize,
}
fn numbering(
    package: &mut Package,
    report: &mut Report,
    control: &mut impl FnMut() -> Result<()>,
) -> Result<Numbering> {
    let rel = tree(package, RELS, control)?;
    let related = rel.as_ref().is_some_and(|r| {
        r.children.iter().any(|n| {
            n.attr("", "Type") == Some(&format!("{R}/numbering"))
                && matches!(
                    n.attr("", "Target"),
                    Some("numbering.xml" | "/word/numbering.xml")
                )
                && n.attr("", "TargetMode").is_none_or(|v| v == "Internal")
        })
    });
    let mut result = Numbering::default();
    if !related {
        if package.part(NUM).is_some() {
            report.diagnostic("UNSUPPORTED_UNRELATED_NUMBERING", NUM);
        }
        return Ok(result);
    }
    let root = tree(package, NUM, control)?.ok_or_else(|| fail(Code::Profile, NUM))?;
    if !root.is("numbering") {
        return Err(fail(Code::Profile, NUM));
    }
    attrs(report, &root, &[]);
    let mut abstract_ids = BTreeMap::new();
    for n in root.children.iter().filter(|n| n.is("abstractNum")) {
        attrs(report, n, &[(W, "abstractNumId")]);
        let id = n
            .attr(W, "abstractNumId")
            .and_then(|v| v.parse::<u32>().ok())
            .ok_or_else(|| fail(Code::Profile, &n.location))?;
        let mut levels = vec![None; 9];
        let mut seen = std::collections::BTreeSet::new();
        for l in &n.children {
            control()?;
            if !l.is("lvl") {
                unknown(report, l);
                continue;
            }
            attrs(report, l, &[(W, "ilvl")]);
            let index = l
                .attr(W, "ilvl")
                .and_then(|v| v.parse::<usize>().ok())
                .filter(|v| *v < 9)
                .ok_or_else(|| fail(Code::Profile, &l.location))?;
            if !seen.insert(index) {
                return Err(fail(Code::Profile, &l.location));
            }
            let mut supported = true;
            for c in &l.children {
                if ["start", "numFmt", "lvlText"].iter().any(|name| c.is(name)) {
                    attrs(report, c, &[(W, "val")]);
                    if !c.children.is_empty() {
                        supported = false;
                        unknown(report, c);
                    }
                } else {
                    report.diagnostic("UNSUPPORTED_NUMBERING_PROPERTY", &c.location);
                    supported = false;
                }
            }
            for key in ["start", "numFmt", "lvlText"] {
                if l.children.iter().filter(|c| c.is(key)).count() > 1 {
                    return Err(fail(Code::Profile, &l.location));
                }
            }
            let start = if l.child("start").is_some() {
                integer(l.child("start"), 2147483647)?
            } else {
                1
            };
            let style = match (
                l.child("numFmt").and_then(Node::val),
                l.child("lvlText").and_then(Node::val),
            ) {
                (Some("decimal"), Some(text))
                    if text == format!("%{}.", index + 1) && start > 0 =>
                {
                    Some(ContainerStyle::Ordered { start })
                }
                (Some("bullet"), Some("•")) => Some(ContainerStyle::Unordered),
                _ => None,
            };
            if supported {
                levels[index] = style.map(|style| Level { style });
            }
            if levels[index].is_none() {
                report.diagnostic("UNSUPPORTED_NUMBERING_LEVEL", &l.location);
            }
        }
        if abstract_ids.insert(id, levels).is_some() {
            return Err(fail(Code::Profile, &n.location));
        }
    }
    for n in root.children.iter().filter(|n| n.is("num")) {
        attrs(report, n, &[(W, "numId")]);
        let id = n
            .attr(W, "numId")
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|v| *v > 0)
            .ok_or_else(|| fail(Code::Profile, &n.location))?;
        if n.children.iter().filter(|n| n.is("abstractNumId")).count() != 1 {
            return Err(fail(Code::Profile, &n.location));
        }
        let aid = integer(n.child("abstractNumId"), u32::MAX)?;
        let mut levels = abstract_ids
            .get(&aid)
            .cloned()
            .ok_or_else(|| fail(Code::Profile, &n.location))?;
        let mut overrides = std::collections::BTreeSet::new();
        for c in &n.children {
            if c.is("abstractNumId") {
                attrs(report, c, &[(W, "val")]);
                continue;
            }
            if !c.is("lvlOverride") {
                unknown(report, c);
                levels.fill(None);
                continue;
            }
            attrs(report, c, &[(W, "ilvl")]);
            let index = c
                .attr(W, "ilvl")
                .and_then(|v| v.parse::<usize>().ok())
                .filter(|v| *v < 9)
                .ok_or_else(|| fail(Code::Profile, &c.location))?;
            if !overrides.insert(index) {
                return Err(fail(Code::Profile, &c.location));
            }
            if c.children.len() != 1 || !c.children[0].is("startOverride") {
                report.diagnostic("UNSUPPORTED_NUMBERING_OVERRIDE", &c.location);
                levels[index] = None;
                continue;
            }
            attrs(report, &c.children[0], &[(W, "val")]);
            let start = integer(Some(&c.children[0]), 2147483647)?;
            match &mut levels[index] {
                Some(Level {
                    style: ContainerStyle::Ordered { start: s },
                }) if start > 0 => *s = start,
                _ => {
                    report.diagnostic("UNSUPPORTED_NUMBERING_OVERRIDE", &c.location);
                    levels[index] = None;
                }
            }
        }
        if result.definitions.insert(id, levels).is_some() {
            return Err(fail(Code::Profile, &n.location));
        }
    }
    for n in &root.children {
        if !n.is("abstractNum") && !n.is("num") {
            unknown(report, n);
        }
    }
    Ok(result)
}
impl Numbering {
    fn containers(
        &mut self,
        p: &Node,
        report: &mut Report,
    ) -> Result<Vec<(String, ContainerStyle)>> {
        let Some(num) = p.child("pPr").and_then(|n| n.child("numPr")) else {
            self.active.clear();
            return Ok(vec![]);
        };
        attrs(report, num, &[]);
        for key in ["ilvl", "numId"] {
            if num.children.iter().filter(|n| n.is(key)).count() > 1 {
                return Err(fail(Code::Profile, &num.location));
            }
        }
        for c in &num.children {
            if c.is("numId") || c.is("ilvl") {
                attrs(report, c, &[(W, "val")]);
            } else {
                unknown(report, c);
            }
        }
        let id = integer(num.child("numId"), u32::MAX)?;
        if id == 0 {
            self.active.clear();
            return Ok(vec![]);
        }
        let level = if num.child("ilvl").is_some() {
            integer(num.child("ilvl"), 8)? as usize
        } else {
            0
        };
        let Some(style) = self
            .definitions
            .get(&id)
            .and_then(|v| v[level].as_ref())
            .map(|l| l.style.clone())
        else {
            report.diagnostic("UNSUPPORTED_NUMBERING_REFERENCE", &num.location);
            self.active.clear();
            return Ok(vec![]);
        };
        if level > self.active.len() || self.active.iter().take(level).any(|(n, _, _, _)| *n != id)
        {
            return Err(fail(Code::Profile, "numbering-missing-ancestor"));
        }
        let next = *self.counters.entry((id, level)).or_insert(match style {
            ContainerStyle::Ordered { start } => start,
            _ => 1,
        });
        self.counters.insert(
            (id, level),
            next.checked_add(1)
                .filter(|v| *v <= 2147483647)
                .ok_or_else(|| fail(Code::Budget, "numbering-counter"))?,
        );
        self.counters.retain(|(n, l), _| *n != id || *l <= level);
        if self.active.get(level).is_none_or(|(n, _, _, _)| *n != id) {
            self.active.truncate(level);
            self.serial += 1;
            let style = match style {
                ContainerStyle::Ordered { .. } => ContainerStyle::Ordered { start: next },
                s => s,
            };
            self.active
                .push((id, level, format!("docx-list-{}", self.serial), style));
        } else {
            self.active.truncate(level + 1);
        }
        Ok(self
            .active
            .iter()
            .map(|(_, _, key, s)| (key.clone(), s.clone()))
            .collect())
    }
}
fn semantic<S: SessionStore + AssetStore>(
    job: &PreparedJob<S>,
    p: AdapterParagraph,
    report: &mut Report,
    now: u64,
) -> Result<FragmentBlock> {
    let prepared = admit(job, vec![p], Report::default(), now)?;
    report.utf16_units += prepared.report.utf16_units;
    report.runs += prepared.report.runs;
    report.paragraphs += 1;
    Ok(prepared.blocks.into_iter().next().unwrap())
}
fn atom(content: Content) -> Result<FragmentBlock> {
    let fallback = content
        .asset_fallback()
        .or_else(|| content.inert_source())
        .unwrap_or("")
        .to_string();
    let tuple = content
        .tuple()
        .map_err(|_| fail(Code::Profile, "shared-content-descriptor"))?;
    Ok(FragmentBlock {
        runs: vec![FragmentRun {
            opaque_marks: vec![],
            text: fallback,
            marks: vec![],
        }],
        attributes: Some(BlockAttributes::Unknown(tuple)),
        containers: vec![],
        checked: None,
    })
}
fn table<S: SessionStore + AssetStore>(
    job: &PreparedJob<S>,
    n: &Node,
    styles: &Styles,
    links: &BTreeMap<String, String>,
    report: &mut Report,
    now: u64,
    control: &mut impl FnMut() -> Result<()>,
) -> Result<Option<FragmentBlock>> {
    attrs(report, n, &[]);
    // Merges and cell containers are not in this profile. Omit the whole table
    // with a report; never commit a partially flattened geometry.
    let mut unsupported_geometry = false;
    for name in ["gridSpan", "vMerge", "hMerge", "tblpPr"] {
        let mut found = vec![];
        descendants(n, W, name, &mut found);
        if !found.is_empty() {
            report.diagnostic(
                if name == "tblpPr" {
                    "UNSUPPORTED_FLOATING_TABLE"
                } else {
                    "UNSUPPORTED_TABLE_MERGE"
                },
                &n.location,
            );
            unsupported_geometry = true;
        }
    }
    if unsupported_geometry {
        return Ok(None);
    }
    let mut rows = vec![];
    let mut fallback = vec![];
    let mut width = None;
    for tr in &n.children {
        control()?;
        if tr.is("tblPr") || tr.is("tblGrid") {
            report.diagnostic("UNSUPPORTED_TABLE_LAYOUT", &tr.location);
            continue;
        }
        if !tr.is("tr") {
            unknown(report, tr);
            continue;
        }
        attrs(report, tr, &[]);
        let mut cells = vec![];
        let mut labels = vec![];
        for tc in &tr.children {
            if !tc.is("tc") {
                unknown(report, tc);
                continue;
            }
            attrs(report, tc, &[]);
            let ps: Vec<_> = tc.children.iter().filter(|c| c.is("p")).collect();
            if ps.len() != 1
                || tc.children.iter().any(|c| !c.is("p") && !c.is("tcPr"))
                || find(tc, W, "numPr")?.is_some()
                || find(tc, W, "drawing")?.is_some()
            {
                report.diagnostic("UNSUPPORTED_TABLE_CELL_CONTENT", &tc.location);
                return Ok(None);
            }
            for props in tc.children.iter().filter(|n| n.is("tcPr")) {
                attrs(report, props, &[]);
                if !props.children.is_empty() || !props.attrs.is_empty() {
                    report.diagnostic("UNSUPPORTED_TABLE_CELL_PROPERTIES", &props.location);
                }
            }
            let p = paragraph(ps[0], styles, links, report, control)?;
            if p.heading.is_some() || p.runs.iter().any(|r| r.source.contains(['\r', '\n'])) {
                report.diagnostic("UNSUPPORTED_TABLE_CELL_BLOCK", &tc.location);
                return Ok(None);
            }
            let b = semantic(job, p, report, now)?;
            labels.push(b.runs.iter().map(|r| r.text.as_str()).collect::<String>());
            cells.push(b.runs);
            if cells.len() > 32 {
                return Err(fail(Code::Budget, "table-columns"));
            }
        }
        if cells.is_empty() || width.is_some_and(|w| w != cells.len()) {
            return Err(fail(Code::Profile, "nonrectangular-table"));
        }
        width = Some(cells.len());
        rows.push(cells);
        fallback.push(labels.join("\t"));
        if rows.len() > 128 {
            return Err(fail(Code::Budget, "table-rows"));
        }
    }
    let width = width.ok_or_else(|| fail(Code::Profile, "empty-table"))?;
    atom(Content::Table {
        alignments: vec![Alignment::None; width],
        rows,
        source: fallback.join("\n"),
    })
    .map(Some)
}
fn image<S: SessionStore + AssetStore>(
    job: &mut PreparedJob<S>,
    package: &mut Package,
    n: &Node,
    rels: Option<&Node>,
    host: &mut impl OriginalMediaHost,
    admitted: &mut BTreeMap<String, (AssetIdentity, [u8; 32])>,
    report: &mut Report,
    now: &mut impl FnMut() -> u64,
) -> Result<Option<FragmentBlock>> {
    if find(n, WP, "anchor")?.is_some() {
        report.diagnostic("UNSUPPORTED_FLOATING_IMAGE", &n.location);
        return Ok(None);
    }
    if find(n, WP, "inline")?.is_none() {
        report.diagnostic("UNSUPPORTED_IMAGE_OBJECT", &n.location);
        return Ok(None);
    }
    if find(n, A, "graphicData")?.is_none_or(|data| data.attr("", "uri") != Some(PIC)) {
        report.diagnostic("UNSUPPORTED_IMAGE_OBJECT", &n.location);
        return Ok(None);
    }
    if find(n, WP, "inline")?.is_some_and(|inline| {
        inline.attrs.iter().any(|((ns, key), value)| {
            ns.is_empty()
                && ["distT", "distB", "distL", "distR"].contains(&key.as_str())
                && value != "0"
        })
    }) {
        report.diagnostic("UNSUPPORTED_IMAGE_SPACING", &n.location);
    }
    // Strict drawing vocabulary: unknown transforms/objects cannot disappear.
    fn inspect(n: &Node, report: &mut Report) {
        let allowed = match (n.ns.as_str(), n.name.as_str()) {
            (W, "drawing" | "r") => Some(vec![]),
            (WP, "inline") => Some(vec![
                ("", "distT"),
                ("", "distB"),
                ("", "distL"),
                ("", "distR"),
            ]),
            (WP, "docPr") => Some(vec![("", "id"), ("", "name"), ("", "descr"), ("", "title")]),
            (A, "graphic") | (PIC, "pic" | "nvPicPr" | "blipFill" | "spPr") => Some(vec![]),
            (A, "graphicData") => Some(vec![("", "uri")]),
            (PIC, "cNvPr") => Some(vec![("", "id"), ("", "name"), ("", "descr")]),
            (PIC, "cNvPicPr") => Some(vec![]),
            (A, "blip") => Some(vec![(R, "embed"), (R, "link")]),
            _ => None,
        };
        if let Some(allowed) = allowed {
            attrs(report, n, &allowed)
        } else {
            report.diagnostic("UNSUPPORTED_IMAGE_TRANSFORM_OR_PROPERTY", &n.location);
        }
        for c in &n.children {
            inspect(c, report)
        }
    }
    inspect(n, report);
    let blip = find(n, A, "blip")?.ok_or_else(|| fail(Code::Profile, "image-blip"))?;
    if blip.attr(R, "link").is_some() {
        report.diagnostic("EXTERNAL_IMAGE_INERT", &blip.location);
        return Ok(None);
    }
    let id = blip
        .attr(R, "embed")
        .ok_or_else(|| fail(Code::Profile, "image-relationship"))?;
    let rel = rels
        .and_then(|r| r.children.iter().find(|r| r.attr("", "Id") == Some(id)))
        .ok_or_else(|| fail(Code::Profile, "missing-image-relationship"))?;
    if rel.attr("", "TargetMode") == Some("External") {
        report.diagnostic("EXTERNAL_IMAGE_INERT", &rel.location);
        return Ok(None);
    }
    if rel.attr("", "Type") != Some(&format!("{R}/image")) {
        return Err(fail(Code::Profile, "image-relationship-type"));
    }
    let target = rel
        .attr("", "Target")
        .ok_or_else(|| fail(Code::Profile, "image-target"))?;
    let part = if let Some(s) = target.strip_prefix('/') {
        s.to_string()
    } else {
        format!("word/{target}")
    };
    if !part.starts_with("word/media/") {
        return Err(fail(Code::Profile, "image-part"));
    }
    let (width, height) = job
        .validate_container_media(package, &part, &mut *now)
        .map_err(|e| {
            let mut f = fail(Code::Package, &format!("{:?}:{}", e.code, e.part));
            f.work = e.work;
            f
        })?;
    let bytes = package
        .part(&part)
        .ok_or_else(|| fail(Code::Package, &part))?;
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    let identity = if let Some((identity, hash)) = admitted.get(&part) {
        if hash != &digest {
            return Err(fail(Code::Profile, "media-identity"));
        }
        identity.clone()
    } else {
        let identity = host
            .identity(&digest)
            .map_err(|_| fail(Code::Job, "media-identity"))?;
        identity
            .validate()
            .map_err(|_| fail(Code::Profile, "media-identity"))?;
        if admitted
            .values()
            .any(|(i, h)| i == &identity && h != &digest)
        {
            return Err(fail(Code::Profile, "media-identity-collision"));
        }
        let duplicate = admitted.values().any(|(i, _)| i == &identity);
        if !duplicate {
            job.stage_asset(
                identity.clone(),
                AssetAction::Ingest,
                bytes.len() as u64,
                &mut Media { host, bytes },
                now(),
            )
            .map_err(|_| fail(Code::Job, "media-stage"))?;
        }
        admitted.insert(part.clone(), (identity.clone(), digest));
        identity
    };
    let props = find(n, WP, "docPr")?;
    let picture_props = find(n, PIC, "cNvPr")?;
    let main_alt = props.and_then(|p| p.attr("", "descr"));
    let picture_alt = picture_props.and_then(|p| p.attr("", "descr"));
    if main_alt.is_some() && picture_alt.is_some() && main_alt != picture_alt {
        report.diagnostic("UNSUPPORTED_CONFLICTING_ALT_TEXT", &n.location);
    }
    let alt = main_alt.or(picture_alt).unwrap_or("").to_string();
    let caption = props
        .and_then(|p| p.attr("", "title"))
        .unwrap_or("")
        .to_string();
    let filename = part.rsplit('/').next().unwrap().to_string();
    let fallback = if alt.is_empty() {
        format!("Image: {filename}")
    } else {
        alt.clone()
    };
    atom(Content::Asset {
        descriptor: AssetDescriptor {
            identity,
            kind: AssetKind::Image,
            metadata: AssetMetadata {
                filename,
                media_type: "image/png".into(),
                byte_length: Some(bytes.len() as u64),
                sha256: Some(format!("{:x}", Sha256::digest(bytes))),
                width: Some(width),
                height: Some(height),
                duration_ms: None,
                alt,
                caption,
            },
            fallback,
            source: String::new(),
        },
    })
    .map(Some)
}
/// Original-input guarded mapping and one shared prepared Session insertion.
/// Paragraph-isolated images only; unsupported constructs retain diagnostics.
pub fn prepare_structure<S: SessionStore + AssetStore>(
    job: &mut PreparedJob<S>,
    budgets: Budgets,
    host: &mut impl OriginalMediaHost,
    mut now: impl FnMut() -> u64,
) -> Result<PreparedText> {
    let result = (|| {
        if job.contract().direction != Direction::Import
            || job.contract().profile.fidelity != STRUCTURE_PROFILE.fidelity
        {
            return Err(fail(Code::Profile, "docx-structure-profile"));
        }
        let mut package = job.prepare_container(budgets, &mut now).map_err(|e| {
            let mut f = fail(Code::Package, &format!("{:?}:{}", e.code, e.part));
            f.work = e.work;
            f
        })?;
        let (document, styles, links, mut report) = context(
            &mut package,
            &mut || job.check(now()).map_err(|_| fail(Code::Job, "control")),
            true,
        )?;
        let mut numbering = numbering(&mut package, &mut report, &mut || {
            job.check(now()).map_err(|_| fail(Code::Job, "control"))
        })?;
        let rels = tree(&mut package, RELS, &mut || {
            job.check(now()).map_err(|_| fail(Code::Job, "control"))
        })?;
        let body = document.children.iter().find(|n| n.is("body")).unwrap();
        attrs(&mut report, body, &[]);
        let mut blocks = vec![];
        let mut admitted = BTreeMap::new();
        for n in &body.children {
            job.check(now()).map_err(|_| fail(Code::Job, "control"))?;
            if n.is("tbl") {
                numbering.active.clear();
                if let Some(b) = table(job, n, &styles, &links, &mut report, now(), &mut || {
                    job.check(now()).map_err(|_| fail(Code::Job, "control"))
                })? {
                    blocks.push(b)
                }
            } else if n.is("p") {
                let mut drawings = vec![];
                descendants(n, W, "drawing", &mut drawings);
                if !drawings.is_empty() {
                    numbering.active.clear();
                    // Do not move mixed inline images to a different text position.
                    let mut texts = vec![];
                    descendants(n, W, "t", &mut texts);
                    if drawings.len() != 1
                        || !texts.is_empty()
                        || n.children.len() != 1
                        || !n.children[0].is("r")
                        || n.children[0].children.len() != 1
                    {
                        report.diagnostic("UNSUPPORTED_INLINE_IMAGE_PLACEMENT", &n.location);
                        let p = paragraph(n, &styles, &links, &mut report, &mut || {
                            job.check(now()).map_err(|_| fail(Code::Job, "control"))
                        })?;
                        blocks.push(semantic(job, p, &mut report, now())?);
                    } else if let Some(b) = image(
                        job,
                        &mut package,
                        drawings[0],
                        rels.as_ref(),
                        host,
                        &mut admitted,
                        &mut report,
                        &mut now,
                    )? {
                        blocks.push(b)
                    }
                } else {
                    let containers = numbering.containers(n, &mut report)?;
                    let mut copy = n.clone();
                    if let Some(p) = copy.children.iter_mut().find(|n| n.is("pPr")) {
                        p.children.retain(|n| !n.is("numPr"));
                    }
                    let p = paragraph(&copy, &styles, &links, &mut report, &mut || {
                        job.check(now()).map_err(|_| fail(Code::Job, "control"))
                    })?;
                    let mut b = semantic(job, p, &mut report, now())?;
                    b.containers = containers;
                    blocks.push(b);
                }
            } else {
                report.diagnostic(
                    match n.name.as_str() {
                        "sectPr" => "UNSUPPORTED_SECTION_HEADERS_FOOTERS",
                        "footnote" => "UNSUPPORTED_FOOTNOTE",
                        _ => "UNSUPPORTED_BODY_STRUCTURE",
                    },
                    &n.location,
                );
                unknown(&mut report, n);
            }
            if blocks.len() > 126
                || report.runs > 1024
                || report.utf16_units > job.contract().limits.output_bytes
            {
                return Err(fail(Code::Budget, "semantic-output"));
            }
        }
        for part in package.part_names() {
            if part.starts_with("word/media/") && !admitted.contains_key(part) {
                report.diagnostic("UNIMPORTED_EMBEDDED_MEDIA", part);
            }
        }
        if blocks.is_empty() {
            let mut e = fail(Code::Profile, "no-supported-structure");
            e.diagnostics = report.diagnostics;
            return Err(e);
        }
        job.check(now())
            .map_err(|_| fail(Code::Job, "post-mapping-control"))?;
        // Charge complete nested tuple representation before preparing/committing.
        let nodes = blocks
            .iter()
            .map(|b| 1 + b.runs.len() + b.containers.len())
            .sum::<usize>()
            + report.runs
            + report.paragraphs;
        package
            .charge_output_nodes(nodes)
            .map_err(|_| fail(Code::Budget, "output-nodes"))?;
        use std::fmt::Write;
        let mut count = Size {
            bytes: 0,
            limit: job.contract().limits.output_bytes,
        };
        write!(&mut count, "{blocks:?}").map_err(|_| fail(Code::Budget, "output-bytes"))?;
        if report.diagnostic_overflow {
            return Err(fail(Code::Budget, "diagnostics"));
        }
        report.package_work = package.work();
        report
            .diagnostics
            .sort_by(|a, b| (&a.location, &a.code).cmp(&(&b.location, &b.code)));
        report.diagnostics.dedup();
        Ok(PreparedText {
            blocks,
            report,
            token: job.token.clone(),
            original_sha256: job.contract().input_sha256,
        })
    })();
    if result.is_err() {
        job.abort().map_err(|_| fail(Code::Job, "cleanup"))?;
    }
    result
}
struct Size {
    bytes: usize,
    limit: usize,
}
impl std::fmt::Write for Size {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        self.bytes = self
            .bytes
            .checked_add(s.len())
            .filter(|v| *v <= self.limit)
            .ok_or(std::fmt::Error)?;
        Ok(())
    }
}
