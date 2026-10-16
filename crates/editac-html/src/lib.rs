//! One inert whitelist importer for browser and native Session. No I/O or live DOM.
use editac_core::{
    commands::{
        editor::{FragmentBlock, FragmentRun},
        format::{Mark, normalize_link_url},
        lists::ContainerStyle,
    },
    document::BlockAttributes,
    interchange::transfer_value,
};
#[cfg(feature = "parser")]
use html5ever::{QualName, local_name, ns, parse_fragment, tendril::TendrilSink};
#[cfg(feature = "parser")]
use markup5ever_rcdom::{Handle, NodeData, RcDom};
use serde_json::{Value, json};

pub struct Imported {
    pub blocks: Vec<FragmentBlock>,
    pub diagnostics: Vec<String>,
}
impl Imported {
    pub fn wire(&self) -> Value {
        json!({"blocks": self.blocks.iter().map(transfer_value).collect::<Vec<_>>(), "diagnostics": self.diagnostics})
    }
}
fn block(path: &[(String, ContainerStyle)], attributes: BlockAttributes) -> FragmentBlock {
    FragmentBlock {
        runs: vec![],
        attributes: Some(attributes),
        containers: path.to_vec(),
        checked: None,
    }
}
#[derive(Default)]
struct Importer {
    blocks: Vec<FragmentBlock>,
    diagnostics: Vec<String>,
    visits: usize,
    runs: usize,
    bytes: usize,
    sequence: usize,
}
impl Importer {
    fn warn(&mut self, code: &str) {
        if !self.diagnostics.iter().any(|d| d == code) {
            self.diagnostics.push(code.into());
        }
    }
    fn flush(&mut self, b: &mut FragmentBlock, empty: bool) -> Result<(), String> {
        if !b.runs.is_empty() || empty {
            if self.blocks.len() >= 128 {
                return Err("html-limit".into());
            }
            self.blocks.push(b.clone());
            b.runs.clear();
        }
        Ok(())
    }
    fn text(
        &mut self,
        text: String,
        marks: &[(Mark, Option<String>)],
        b: &mut FragmentBlock,
    ) -> Result<(), String> {
        self.runs += 1;
        self.bytes += text.len();
        if self.runs > 1024 || self.bytes > 1_048_576 {
            return Err("html-limit".into());
        }
        if !text.is_empty() {
            b.runs.push(FragmentRun {
                text,
                marks: marks.to_vec(),
            });
        }
        Ok(())
    }
    fn walk(
        &mut self,
        node: &Value,
        marks: &[(Mark, Option<String>)],
        path: &[(String, ContainerStyle)],
        depth: usize,
        b: &mut FragmentBlock,
    ) -> Result<(), String> {
        self.visits += 1;
        if self.visits > 4096 || depth > 32 {
            return Err("html-limit".into());
        }
        let invalid = || "html-tree-invalid".to_string();
        let object = node.as_object().ok_or_else(invalid)?;
        let (tag, attrs, children) = match node["kind"].as_str() {
            Some("text") if object.len() == 2 => {
                return self.text(node["text"].as_str().ok_or_else(invalid)?.into(), marks, b);
            }
            Some("inert") if object.len() == 1 => return Ok(()),
            Some("element") if object.len() == 4 => (
                node["tag"].as_str().ok_or_else(invalid)?,
                node["attributes"].as_array().ok_or_else(invalid)?,
                node["children"].as_array().ok_or_else(invalid)?,
            ),
            _ => return Err(invalid()),
        };
        let attr = |key: &str| {
            attrs
                .iter()
                .find(|a| {
                    a["name"].as_str() == Some(key) && a["namespaced"].as_bool() == Some(false)
                })
                .and_then(|a| a["value"].as_str())
                .map(String::from)
        };
        for a in attrs {
            if a.as_object().ok_or_else(invalid)?.len() != 3 || !a["namespaced"].is_boolean() {
                return Err(invalid());
            }
            let value = a["value"].as_str().ok_or_else(invalid)?;
            let name = a["name"].as_str().ok_or_else(invalid)?;
            if value.encode_utf16().count() > 4096 {
                return Err("html-attribute-limit".into());
            }
            if !["href", "start", "style"].contains(&name) || a["namespaced"] != false {
                self.warn("html-attribute-dropped");
            }
        }
        if [
            "script", "style", "iframe", "object", "embed", "link", "meta", "noscript", "template",
        ]
        .contains(&tag)
        {
            self.warn("html-executable-dropped");
            return Ok(());
        }
        if !tag.is_empty()
            && ![
                "p",
                "div",
                "span",
                "li",
                "ul",
                "ol",
                "blockquote",
                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",
                "pre",
                "br",
                "b",
                "strong",
                "i",
                "em",
                "s",
                "del",
                "strike",
                "u",
                "code",
                "a",
            ]
            .contains(&tag)
        {
            self.warn("html-element-dropped");
        }
        if ["table", "img", "video", "audio", "canvas", "math", "svg"].contains(&tag) {
            return Err(format!("html-{tag}-requires-extension-codec"));
        }
        if tag == "br" {
            return self.text("\n".into(), marks, b);
        }
        let mut next = marks.to_vec();
        let mut add = |mark, href| {
            next.retain(|(m, _)| *m != mark);
            next.push((mark, href));
        };
        let mark = match tag {
            "b" | "strong" => Some(Mark::Bold),
            "i" | "em" => Some(Mark::Italic),
            "s" | "del" | "strike" => Some(Mark::Strike),
            "u" => Some(Mark::Underline),
            "code" if !matches!(b.attributes, Some(BlockAttributes::Code(..))) => Some(Mark::Code),
            _ => None,
        };
        if let Some(mark) = mark {
            add(mark, None);
        }
        if tag == "a" {
            if let Some(href) = attr("href").filter(|s| !s.is_empty()) {
                if normalize_link_url(&href).is_ok() {
                    add(Mark::Link, Some(href));
                } else {
                    self.warn("html-url-dropped");
                }
            }
        }
        if let Some(css) = attr("style").filter(|s| !s.is_empty()) {
            self.warn("html-css-reduced-to-marks");
            for declaration in css.to_ascii_lowercase().split(';') {
                let Some((name, value)) = declaration.split_once(':') else {
                    continue;
                };
                let value = value
                    .trim()
                    .strip_suffix("!important")
                    .unwrap_or(value.trim())
                    .trim();
                match name.trim() {
                    "font-weight" if value == "bold" || ["700", "800", "900"].contains(&value) => {
                        add(Mark::Bold, None)
                    }
                    "font-style" if value == "italic" => add(Mark::Italic, None),
                    "text-decoration" | "text-decoration-line" => {
                        if value.split_whitespace().any(|v| v == "underline") {
                            add(Mark::Underline, None);
                        }
                        if value.split_whitespace().any(|v| v == "line-through") {
                            add(Mark::Strike, None);
                        }
                    }
                    _ => (),
                }
            }
        }
        if ["ul", "ol", "blockquote"].contains(&tag) {
            self.flush(b, false)?;
            self.sequence += 1;
            let style = match tag {
                "blockquote" => ContainerStyle::Quote,
                "ol" => ContainerStyle::Ordered {
                    start: attr("start")
                        .and_then(|v| v.parse::<f64>().ok())
                        .filter(|n| n.is_finite())
                        .unwrap_or(1.0)
                        .clamp(1.0, 2147483647.0) as u32,
                },
                _ => ContainerStyle::Unordered,
            };
            let mut path = path.to_vec();
            path.push((format!("html-{}", self.sequence), style));
            let mut nested = block(&path, BlockAttributes::Paragraph);
            for child in children.iter() {
                self.walk(child, &next, &path, depth + 1, &mut nested)?;
            }
            return self.flush(&mut nested, false);
        }
        if ["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre"].contains(&tag) {
            self.flush(b, false)?;
            let attributes = if tag.starts_with('h') {
                BlockAttributes::Heading(tag.as_bytes()[1] - b'0')
            } else if tag == "pre" {
                BlockAttributes::Code(String::new())
            } else {
                BlockAttributes::Paragraph
            };
            let mut nested = block(path, attributes);
            for child in children.iter() {
                self.walk(child, &next, path, depth + 1, &mut nested)?;
            }
            return self.flush(&mut nested, children.is_empty());
        }
        for child in children.iter() {
            self.walk(child, &next, path, depth + 1, b)?;
        }
        Ok(())
    }
}
/// Apply the shared whitelist to tokenizer output. Browser DOM parsing is inert;
/// all semantic decisions, URLs, marks, containers and diagnostics remain here.
pub fn import_tree(nodes: &[Value]) -> Result<Imported, String> {
    let mut importer = Importer::default();
    let mut root = block(&[], BlockAttributes::Paragraph);
    for node in nodes {
        importer.walk(node, &[], &[], 1, &mut root)?;
    }
    importer.flush(&mut root, false)?;
    if importer.blocks.is_empty() {
        return Err("html-empty".into());
    }
    Ok(Imported {
        blocks: importer.blocks,
        diagnostics: importer.diagnostics,
    })
}
pub fn import_tree_json(input: &str) -> Result<Imported, String> {
    // Escaped text/attributes can be several times the original UTF-8 source.
    if input.len() > 8 * 1_048_576 {
        return Err("html-limit".into());
    }
    let value: Value = serde_json::from_str(input).map_err(|_| "html-tree-invalid".to_string())?;
    let nodes = value
        .as_array()
        .ok_or_else(|| "html-tree-invalid".to_string())?;
    import_tree(nodes)
}
#[cfg(feature = "parser")]
pub fn import(raw: &str) -> Result<Imported, String> {
    if raw.len() > 1_048_576 {
        return Err("html-limit".into());
    }
    let dom = parse_fragment(
        RcDom::default(),
        Default::default(),
        QualName::new(None, ns!(html), local_name!(template)),
        vec![],
        false,
    )
    .one(raw);
    fn convert(node: &Handle, depth: usize, count: &mut usize) -> Result<Value, String> {
        *count += 1;
        if depth > 32 || *count > 4096 {
            return Err("html-limit".into());
        }
        Ok(match &node.data {
            NodeData::Text { contents } => {
                json!({"kind":"text", "text":contents.borrow().to_string()})
            }
            NodeData::Element { name, attrs, .. } => json!({
                "kind":"element", "tag":name.local.as_ref(),
                "attributes": attrs.borrow().iter().map(|a| json!({"name":a.name.local.as_ref(),"value":a.value.as_ref(),"namespaced":a.name.ns != ns!()})).collect::<Vec<_>>(),
                "children":node.children.borrow().iter().map(|c| convert(c, depth+1, count)).collect::<Result<Vec<_>,String>>()?,
            }),
            _ => json!({"kind":"inert"}),
        })
    }
    let mut count = 0;
    let mut nodes = vec![];
    for root in dom.document.children.borrow().iter() {
        for child in root.children.borrow().iter() {
            nodes.push(convert(child, 1, &mut count)?);
        }
    }
    import_tree(&nodes)
}

#[cfg(all(test, feature = "parser"))]
mod tests {
    use super::*;
    fn text(v: &Imported) -> String {
        v.blocks
            .iter()
            .flat_map(|b| b.runs.iter().map(|r| r.text.as_str()))
            .collect()
    }
    #[test]
    fn palette_containers_marks_and_pre_whitespace() {
        let v = import("<h2><strong>é😀</strong></h2><ol start=3><li><em>one</em><ul><li><u>two</u></li></ul></li></ol><p><a href='https://example.com/a'>link</a><s>strike</s><code>literal</code></p><pre>  x\n\ty</pre>").unwrap();
        assert!(v.diagnostics.is_empty());
        assert_eq!(v.blocks[0].attributes, Some(BlockAttributes::Heading(2)));
        assert_eq!(v.blocks[0].runs[0].marks[0].0, Mark::Bold);
        assert!(v.blocks.iter().any(|b| b.containers.len() == 2));
        assert_eq!(v.blocks.last().unwrap().runs[0].text, "  x\n\ty");
        assert!(v.wire().to_string().contains("https://example.com/a"));
    }
    #[test]
    fn executable_subtrees_attributes_and_css_are_inert() {
        let v=import("<script>bad</script><iframe src='https://attack.invalid'></iframe><style>bad</style><p onclick='bad' style='background:url(https://attack.invalid);font-weight:bold;text-decoration:underline line-through'>safe</p>").unwrap();
        assert_eq!(text(&v), "safe");
        assert!(v.diagnostics.contains(&"html-executable-dropped".into()));
        assert_eq!(v.blocks[0].runs[0].marks.len(), 3);
    }
    #[test]
    fn decoded_unsafe_urls_are_text() {
        for href in [
            "java&#115;cript:alert(1)",
            "data:text/html,x",
            "https://user:pass@example.com/",
            "https://example.com/%0a",
            "/relative",
            "#local",
            "https://example.com/&#10;",
            "https://example.com/%20",
            "https://example.com/\\bad",
        ] {
            let v = import(&format!("<a href='{href}'>safe</a>")).unwrap();
            assert_eq!(text(&v), "safe");
            assert!(v.blocks[0].runs[0].marks.is_empty(), "{href}");
            assert!(v.diagnostics.contains(&"html-url-dropped".into()));
        }
    }
    #[test]
    fn optional_resources_require_registered_codecs() {
        for tag in ["table", "img", "video", "audio", "canvas", "math", "svg"] {
            assert!(
                import(&format!("<{tag}>x</{tag}>"))
                    .err()
                    .unwrap()
                    .contains("requires-extension-codec")
            );
        }
    }
    #[test]
    fn malformed_html_uses_html5_repair_and_decodes_entities() {
        let v = import("<p><b>bold<i>nested</b> tail</i>&amp;&#x1f600;</p>").unwrap();
        assert_eq!(text(&v), "boldnested tail&😀");
        assert!(
            v.blocks[0]
                .runs
                .iter()
                .any(|r| r.text.contains(" tail") && r.marks.iter().any(|m| m.0 == Mark::Italic))
        );
    }
    #[test]
    fn byte_depth_attribute_and_block_limits() {
        for raw in [
            "x".repeat(1_048_577),
            format!("{}x{}", "<div>".repeat(34), "</div>".repeat(34)),
            format!("<p title='{}'>x</p>", "x".repeat(4097)),
            "<p>x</p>".repeat(129),
            "<span>x</span>".repeat(1025),
            "<!--comment-->".repeat(4097),
        ] {
            assert!(import(&raw).is_err());
        }
    }
    #[test]
    fn code_has_no_nested_code_mark_and_unknown_elements_keep_text() {
        let v = import("<pre><code> a\n b</code></pre><custom>x</custom>").unwrap();
        assert!(v.blocks[0].runs[0].marks.is_empty());
        assert_eq!(text(&v), " a\n bx");
        assert!(v.diagnostics.contains(&"html-element-dropped".into()));
    }
    #[test]
    fn empty_and_executable_only_html_rejects() {
        for raw in ["", "<script>x</script>", "<!--x-->"] {
            assert!(import(raw).is_err());
        }
    }
}

#[cfg(test)]
mod tree_tests {
    use super::*;
    #[test]
    fn inert_token_transport_admits_only_data_and_returns_shared_semantics() {
        let imported=import_tree_json(r#"[{"kind":"element","tag":"h2","attributes":[],"children":[{"kind":"element","tag":"b","attributes":[],"children":[{"kind":"text","text":"é😀"}]}]}]"#).unwrap();
        let wire = imported.wire();
        assert_eq!(wire["blocks"][0]["attributes"]["type"], "heading");
        assert_eq!(wire["blocks"][0]["runs"][0]["marks"][0]["mark"], "bold");
    }
    #[test]
    fn malformed_or_semantic_token_payloads_reject() {
        for raw in [
            "null",
            "{}",
            r#"[{"kind":"text","text":"x","marks":["bold"]}]"#,
            r#"[{"kind":"element","tag":"p","attributes":[],"children":[],"documentId":"spoof"}]"#,
        ] {
            assert!(import_tree_json(raw).is_err());
        }
        assert!(import_tree_json(&" ".repeat(8 * 1_048_576 + 1)).is_err());
    }
    #[test]
    fn direct_token_callers_cannot_bypass_common_limits_or_url_policy() {
        let mut node = json!({"kind":"text","text":"x"});
        for _ in 0..33 {
            node = json!({"kind":"element","tag":"span","attributes":[],"children":[node]});
        }
        assert!(import_tree(&[node]).is_err());
        let v=import_tree_json(r#"[{"kind":"element","tag":"a","attributes":[{"name":"href","value":"javascript:bad","namespaced":false}],"children":[{"kind":"text","text":"safe"}]}]"#).unwrap();
        assert!(v.blocks[0].runs[0].marks.is_empty());
        assert_eq!(v.diagnostics, ["html-url-dropped"]);
    }
}
