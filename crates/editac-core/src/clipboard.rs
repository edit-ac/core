//! Pure v1 clipboard shape validation. Semantic preparation remains authoritative.
use serde_json::Value;
const LIMIT: usize = 1_048_576;
type Result<T> = std::result::Result<T, &'static str>;
fn require(ok: bool, reason: &'static str) -> Result<()> {
    if ok { Ok(()) } else { Err(reason) }
}
fn keys(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str())))
}
fn text_length(value: &Value) -> Option<usize> {
    value.as_str().map(|s| s.encode_utf16().count())
}
fn kind(value: &Value, field: &str, choices: &[&str]) -> bool {
    value[field].as_str().is_some_and(|s| choices.contains(&s))
}
fn optional(value: &Value, field: &str) -> bool {
    value.get(field).is_none_or(Value::is_null)
}
/// Checks shape/limits only; creates no semantic document, anchors, plans or history.
pub fn validate(raw: &str, schema: &str) -> Result<()> {
    require(raw.len() <= LIMIT, "fragment-limit")?;
    let value: Value = serde_json::from_str(raw).map_err(|_| "fragment-schema")?;
    require(
        keys(&value, &["version", "schema", "blocks"])
            && value["version"].as_f64() == Some(1.0)
            && value["schema"] == schema
            && value["blocks"]
                .as_array()
                .is_some_and(|b| !b.is_empty() && b.len() <= 128),
        "fragment-schema",
    )?;
    let mut count = 0;
    let mut size = 0;
    for block in value["blocks"].as_array().unwrap() {
        require(
            keys(block, &["runs", "attributes", "containers", "checked"])
                && block["runs"].as_array().is_some_and(|r| r.len() <= 1024),
            "fragment-block",
        )?;
        require(
            optional(block, "checked") || block["checked"].is_boolean(),
            "fragment-check",
        )?;
        if let Some(containers) = block.get("containers") {
            require(
                containers.as_array().is_some_and(|c| c.len() <= 16),
                "fragment-container",
            )?;
            for container in containers.as_array().unwrap() {
                require(
                    keys(container, &["key", "style"])
                        && text_length(&container["key"]).is_some_and(|n| n > 0 && n <= 128)
                        && kind(
                            &container["style"],
                            "type",
                            &["unordered", "ordered", "checklist", "quote"],
                        ),
                    "fragment-container",
                )?;
                let style = &container["style"];
                require(
                    if style["type"] == "ordered" {
                        keys(style, &["type", "start"])
                            && style["start"].as_f64().is_some_and(|n| {
                                n.fract() == 0.0 && (0.0..=2_147_483_647.0).contains(&n)
                            })
                    } else {
                        keys(style, &["type"])
                    },
                    "fragment-container",
                )?;
            }
        }
        let a = &block["attributes"];
        require(
            kind(
                a,
                "type",
                &["paragraph", "heading", "code", "separator", "content"],
            ),
            "fragment-style",
        )?;
        match a["type"].as_str().unwrap() {
            "paragraph" | "separator" => require(keys(a, &["type"]), "fragment-style")?,
            "content" => require(
                keys(a, &["type", "tuple"])
                    && a["tuple"].as_array().is_some_and(|t| {
                        t.first().and_then(Value::as_str).is_some_and(|s| {
                            [
                                "module:editac.asset",
                                "module:editac.image",
                                "module:editac.table",
                                "module:editac.callout",
                                "module:editac.reference",
                                "module:editac.inert-extension",
                            ]
                            .contains(&s)
                        })
                    }),
                "fragment-content",
            )?,
            "heading" => require(
                keys(a, &["type", "level"])
                    && a["level"]
                        .as_f64()
                        .is_some_and(|n| n.fract() == 0.0 && (1.0..=6.0).contains(&n)),
                "fragment-heading",
            )?,
            "code" => require(
                keys(a, &["type", "language"])
                    && text_length(&a["language"]).is_some_and(|n| n <= 128),
                "fragment-code",
            )?,
            _ => unreachable!(),
        }
        for run in block["runs"].as_array().unwrap() {
            count += 1;
            require(
                count <= 1024
                    && keys(run, &["text", "marks", "opaqueMarks", "attributes"])
                    && run["text"].is_string()
                    && run["marks"].as_array().is_some_and(|m| m.len() <= 6),
                "fragment-run",
            )?;
            let mut combined = if let Some(attributes) = run.get("attributes") {
                crate::commands::fragment::registered_attributes(attributes)
                    .map_err(|_| "fragment-attributes")?
            } else {
                Vec::new()
            };
            if let Some(raw) = run.get("opaqueMarks") {
                require(
                    raw.as_array().is_some_and(|a| a.len() <= 32),
                    "fragment-opaque-mark",
                )?;
                let mut marks = Vec::new();
                for m in raw.as_array().unwrap() {
                    require(
                        keys(m, &["key", "value"])
                            && m["key"].is_string()
                            && m.get("value").is_some(),
                        "fragment-opaque-mark",
                    )?;
                    let value = yrs::Any::from_json(&m["value"].to_string())
                        .map_err(|_| "fragment-opaque-mark")?;
                    marks.push((m["key"].as_str().unwrap().to_owned(), value));
                }
                combined.extend(marks);
                crate::commands::fragment::validate_opaque_marks(&combined)
                    .map_err(|_| "fragment-opaque-mark")?;
            }
            size += run["text"].as_str().unwrap().len();
            let mut seen = Vec::new();
            for mark in run["marks"].as_array().unwrap() {
                require(
                    keys(mark, &["mark", "href"])
                        && kind(
                            mark,
                            "mark",
                            &["bold", "italic", "strike", "underline", "code", "link"],
                        )
                        && !seen.contains(&mark["mark"]),
                    "fragment-mark",
                )?;
                seen.push(mark["mark"].clone());
                if mark["mark"] == "link" {
                    require(
                        text_length(&mark["href"]).is_some_and(|n| n <= 4096)
                            && mark["href"].as_str().is_some_and(|s| {
                                let lower = s.to_ascii_lowercase();
                                ["http:", "https:", "mailto:", "#"]
                                    .iter()
                                    .any(|p| lower.starts_with(p))
                                    && !s.chars().any(|c| c <= ' ' || c == '\u{7f}')
                            }),
                        "fragment-url",
                    )?;
                } else {
                    require(optional(mark, "href"), "fragment-mark")?;
                }
            }
        }
    }
    require(size <= LIMIT, "fragment-limit")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn valid() -> Value {
        json!({"version":1,"schema":"s","blocks":[{"runs":[{"text":"😀 שלום","marks":[]}],"attributes":{"type":"paragraph"}}]})
    }
    #[test]
    fn portable_valid_fragment_and_numeric_version() {
        assert_eq!(validate(&valid().to_string(), "s"), Ok(()));
        assert_eq!(
            validate(
                &valid()
                    .to_string()
                    .replace("\"version\":1", "\"version\":1.0"),
                "s"
            ),
            Ok(())
        );
    }
    #[test]
    fn schema_and_unknown_fields_are_rejected() {
        assert_eq!(
            validate(&valid().to_string(), "other"),
            Err("fragment-schema")
        );
        let mut v = valid();
        v["extra"] = json!(true);
        assert_eq!(validate(&v.to_string(), "s"), Err("fragment-schema"));
    }
    #[test]
    fn exact_resource_boundary() {
        let raw = valid().to_string();
        assert_eq!(
            validate(&format!("{raw}{}", " ".repeat(LIMIT - raw.len())), "s"),
            Ok(())
        );
        assert_eq!(
            validate(&format!("{raw}{}", " ".repeat(LIMIT + 1 - raw.len())), "s"),
            Err("fragment-limit")
        );
    }
    #[test]
    fn utf16_container_and_url_limits() {
        let mut v = valid();
        v["blocks"][0]["containers"] =
            json!([{"key":"😀".repeat(64),"style":{"type":"ordered","start":2147483647}}]);
        assert_eq!(validate(&v.to_string(), "s"), Ok(()));
        v["blocks"][0]["containers"][0]["key"] = json!("😀".repeat(65));
        assert_eq!(validate(&v.to_string(), "s"), Err("fragment-container"));
    }
    #[test]
    fn ordered_start_zero_preserves_bounded_fragment_admission() {
        let mut v = valid();
        v["blocks"][0]["containers"] = json!([{"key":"list","style":{"type":"ordered","start":0}}]);
        assert_eq!(validate(&v.to_string(), "s"), Ok(()));
        for start in [
            json!(-1),
            json!(0.5),
            json!(2147483648u64),
            json!("0"),
            json!(null),
        ] {
            v["blocks"][0]["containers"][0]["style"]["start"] = start;
            assert_eq!(validate(&v.to_string(), "s"), Err("fragment-container"));
        }
    }
    #[test]
    fn international_links_remain_structurally_admitted() {
        let mut v = valid();
        for href in ["HTTPS://例え.テスト/道", "mailto:א@example.com", "#שלום"] {
            v["blocks"][0]["runs"][0]["marks"] = json!([{"mark":"link","href":href}]);
            assert_eq!(validate(&v.to_string(), "s"), Ok(()));
        }
        for href in ["javascript:alert(1)", "https://a/ bad", "http:\u{7f}"] {
            v["blocks"][0]["runs"][0]["marks"] = json!([{"mark":"link","href":href}]);
            assert_eq!(validate(&v.to_string(), "s"), Err("fragment-url"));
        }
    }
}

#[cfg(test)]
mod opaque_clipboard_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn opaque_shapes_profiles_limits_and_duplicates_are_shared() {
        let base = json!({"version":1,"schema":"s","blocks":[{"attributes":{"type":"paragraph"},"runs":[{"text":"😀","marks":[{"mark":"bold"}],"opaqueMarks":[{"key":"vendor-note","value":{"version":1,"nested":[false,"value"]}}]}]}]});
        assert_eq!(validate(&base.to_string(), "s"), Ok(()));
        assert_eq!(validate(&base.to_string(), "other"), Err("fragment-schema"));
        let mut deep = json!(1);
        for _ in 0..10 {
            deep = json!([deep]);
        }
        for marks in [
            json!([{"key":"bold","value":true}]),
            json!([{"key":"x","value":null}]),
            json!([{"key":"x","value":1},{"key":"x","value":2}]),
            json!([{"key":"x","value":deep}]),
            json!([{"key":"x","value":"x".repeat(16385)}]),
            json!([{"key":"x","value":true,"execute":true}]),
            json!({"x":true}),
        ] {
            let mut invalid = base.clone();
            invalid["blocks"][0]["runs"][0]["opaqueMarks"] = marks;
            assert_eq!(
                validate(&invalid.to_string(), "s"),
                Err("fragment-opaque-mark")
            );
        }
    }
}
