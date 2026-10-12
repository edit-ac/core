//! One corpus exercises the native production bridge and compiled WASM.
use crate::bridge::Bridge;
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::PathBuf};
use yrs::{
    IndexScope, StickyIndex,
    updates::{decoder::Decode, encoder::Encode},
};
fn substitute(v: &Value, refs: &BTreeMap<String, String>) -> Value {
    match v {
        Value::String(s) if s.starts_with('$') => json!(
            refs.get(&s[1..])
                .unwrap_or_else(|| panic!("missing reference {s}"))
        ),
        Value::Array(a) => Value::Array(a.iter().map(|v| substitute(v, refs)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), substitute(v, refs)))
                .collect(),
        ),
        _ => v.clone(),
    }
}
fn normalize(s: &str, writer: &str) -> String {
    if ["n", "c", "o"]
        .iter()
        .any(|p| s.starts_with(&format!("{p}:{writer}:")))
        || s.starts_with(&format!("{writer}:"))
        || s.starts_with(&format!("<{writer}#"))
        || s.contains(&format!("client: ClientID({writer})"))
    {
        s.replace(writer, "WRITER")
    } else {
        s.into()
    }
}
fn canonical(v: &Value, writer: &str) -> Value {
    match v {
        Value::String(s) => json!(normalize(s, writer)),
        Value::Array(a) => {
            let mut result = a.iter().map(|v| canonical(v, writer)).collect::<Vec<_>>();
            if a.len() == 7 && a[0] == "split" {
                let bytes = a[5]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| u8::try_from(v.as_u64().unwrap()).unwrap())
                    .collect::<Vec<_>>();
                let p = StickyIndex::decode_v1(&bytes).unwrap();
                assert_eq!(
                    p.encode_v1(),
                    bytes,
                    "noncanonical/trailing relative anchor bytes"
                );
                let mut decoded = json!({"assoc":p.assoc as i8});
                let mut id = |key: &str, i: &yrs::ID| {
                    decoded[key] = json!({"client":if i.client.get().to_string()==writer { "WRITER".to_string() } else { i.client.get().to_string() },"clock":i.clock});
                };
                match p.scope() {
                    IndexScope::Relative(i) => id("item", i),
                    IndexScope::Nested(i) => id("type", i),
                    IndexScope::Root(n) => decoded["tname"] = json!(n.as_ref()),
                }
                result[5] = decoded;
            }
            Value::Array(result)
        }
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| {
                    (
                        normalize(k, writer),
                        if matches!(k.as_str(), "attributes" | "text" | "insert") {
                            v.clone()
                        } else {
                            canonical(v, writer)
                        },
                    )
                })
                .collect(),
        ),
        _ => v.clone(),
    }
}
fn text(n: &Value) -> String {
    n["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["text"].as_str().unwrap())
        .collect()
}
fn assert_expect(s: &Value, e: &Value) {
    let nodes = s["visible"].as_array().unwrap();
    let blocks = nodes
        .iter()
        .filter(|n| n["kind"] == "block" && n["blockAttributes"][0] != "separator")
        .collect::<Vec<_>>();
    assert_eq!(
        json!(blocks.iter().map(|n| text(n)).collect::<Vec<_>>()),
        e["texts"]
    );
    if let Some(b) = e.get("block") {
        assert_eq!(blocks[0]["blockAttributes"], *b);
    }
    if let Some(m) = e.get("mark") {
        assert!(
            blocks[0]["runs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["attributes"].get(m.as_str().unwrap()).is_some()),
            "missing {m}"
        );
    }
    if let Some(m) = e.get("absentMark") {
        assert!(
            blocks[0]["runs"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["attributes"].get(m.as_str().unwrap()).is_none()),
            "unexpected {m}"
        );
    }
    if let Some(x) = e.get("unmarkedSuffix") {
        let r = blocks[0]["runs"].as_array().unwrap().last().unwrap();
        assert!(r["text"].as_str().unwrap().ends_with(x.as_str().unwrap()));
        assert!(r["attributes"].as_object().unwrap().is_empty());
    }
    if let Some(x) = e.get("spans") {
        assert_eq!(
            blocks[0]["spans"].as_array().unwrap().len() as u64,
            x.as_u64().unwrap()
        );
    }
    if let Some(x) = e.get("numbers") {
        assert_eq!(
            json!(
                blocks
                    .iter()
                    .map(|n| n["editor"]["number"].clone())
                    .collect::<Vec<_>>()
            ),
            *x
        );
    }
    if let Some(x) = e.get("checked") {
        assert_eq!(blocks[0]["editor"]["checked"], *x);
    }
    if let Some(x) = e.get("separators") {
        assert_eq!(
            nodes
                .iter()
                .filter(|n| n["blockAttributes"][0] == "separator")
                .count() as u64,
            x.as_u64().unwrap()
        );
    }
    if e.get("rootBlock") == Some(&json!(true)) {
        assert_eq!(blocks[0]["parent"], "@root");
    }
}
fn run(index: usize) {
    let corpus: Value =
        serde_json::from_str(include_str!("../../../fixtures/wasm-commands/cases.json")).unwrap();
    let case = &corpus["cases"][index];
    let mut b = Bridge::create(&case["create"].to_string()).unwrap();
    let initial = b.read().unwrap();
    let mut refs = BTreeMap::new();
    for (i, n) in initial["visible"].as_array().unwrap().iter().enumerate() {
        refs.insert(i.to_string(), n["id"].as_str().unwrap().to_owned());
    }
    let writer = initial["visible"][0]["id"]
        .as_str()
        .unwrap()
        .split(':')
        .nth(1)
        .unwrap()
        .to_owned();
    let mut output = vec![canonical(&initial, &writer)];
    let mut raw_output = vec![initial.clone()];
    for raw in case["steps"].as_array().unwrap() {
        let s = substitute(raw, &refs);
        match s["action"].as_str().unwrap() {
            "anchor" => {
                let a = b
                    .capture(
                        &json!({"node":s["node"],"offset":s["offset"],"bias":s["bias"]})
                            .to_string(),
                    )
                    .unwrap();
                refs.insert(
                    s["name"].as_str().unwrap().into(),
                    a["token"].as_str().unwrap().into(),
                );
            }
            "commit" => {
                let before = b.doc_state();
                let p = b.prepare(&s["request"].to_string()).unwrap();
                assert_eq!(b.doc_state(), before, "preparation mutated replica");
                b.commit(p["token"].as_str().unwrap()).unwrap();
            }
            "history" => {
                b.history(&s["request"].to_string()).unwrap();
            }
            "expect" => {
                let snapshot = b.read().unwrap();
                assert_expect(&snapshot, &s);
                output.push(canonical(&snapshot, &writer));
                raw_output.push(snapshot);
            }
            "remember" => {
                let snapshot = b.read().unwrap();
                let kind = s["kind"].as_str().unwrap();
                let selected = snapshot["visible"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|n| {
                        if kind == "separator" {
                            n["blockAttributes"][0] == "separator"
                        } else {
                            n["kind"] == kind && n["blockAttributes"][0] != "separator"
                        }
                    })
                    .nth(s["index"].as_u64().unwrap() as usize)
                    .unwrap();
                refs.insert(
                    s["name"].as_str().unwrap().into(),
                    selected["id"].as_str().unwrap().into(),
                );
            }
            "resolve" => {
                let r = b.resolve(s["token"].as_str().unwrap()).unwrap();
                assert_eq!(r["type"], s["type"]);
                if let Some(o) = s.get("offset") {
                    assert_eq!(r["offset"], *o);
                }
                output.push(canonical(&r, &writer));
                raw_output.push(r);
            }
            x => panic!("unknown action {x}"),
        }
    }
    if let Some(dir) = std::env::var_os("EDITAC_WASM_COMMAND_OUTPUT") {
        let p = PathBuf::from(dir);
        fs::create_dir_all(&p).unwrap();
        fs::write(
            p.join(format!("native-raw-{}.json", case["id"].as_str().unwrap())),
            serde_json::to_string_pretty(&raw_output).unwrap(),
        )
        .unwrap();
        fs::write(
            p.join(format!("native-{}.json", case["id"].as_str().unwrap())),
            serde_json::to_string_pretty(&output).unwrap(),
        )
        .unwrap();
    }
}
macro_rules! case {
    ($name:ident,$n:expr) => {
        #[test]
        fn $name() {
            run($n);
        }
    };
}
case!(unicode_replace, 0);
case!(text_insert_delete, 1);
case!(rich_marks, 2);
case!(heading_levels, 3);
case!(split_start, 4);
case!(split_middle, 5);
case!(split_end, 6);
case!(split_empty, 7);
case!(retained_join, 8);
case!(literal_code, 9);
case!(list_quote_nesting, 10);
case!(list_enter_backspace, 11);
case!(empty_item_exit, 12);
case!(separator_access, 13);
case!(separator_insert, 14);
case!(semantic_move, 15);
case!(history_grouping, 16);

fn fresh(i: u32) -> Bridge {
    Bridge::create(&json!({"profile":"v5","documentId":format!("73000000-0000-4000-8000-{i:012}"),"epoch":format!("74000000-0000-4000-8000-{i:012}"),"nodes":[{"text":"a😀b"}]}).to_string()).unwrap()
}
fn first(b: &Bridge) -> String {
    b.read().unwrap()["visible"][0]["id"]
        .as_str()
        .unwrap()
        .into()
}
#[test]
fn invalid_requests_preserve_exact_bytes_revision_and_history() {
    let mut b = fresh(1);
    let node = first(&b);
    let a = b
        .capture(&json!({"node":node,"offset":0,"bias":"left"}).to_string())
        .unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let before = b.doc_state();
    for input in ["null".to_owned(),"{}".to_owned(),"{bad".to_owned(),
        json!({"kind":"editor","origin":"test","commands":[{"type":"insert","at":a,"text":"valid"},{"type":"insert","at":"invalid","text":"bad"}]}).to_string(),
        json!({"kind":"editor","origin":"test","commands":[{"type":"join","first":node,"second":node}]}).to_string(),
        json!({"kind":"editor","origin":"test","commands":[],"unknown":true}).to_string(),
        json!({"kind":"format","origin":"test","marks":[],"blocks":[{"targets":[node],"attributes":{"type":"heading","level":7},"action":"apply"}]}).to_string(),
        "x".repeat(2*1024*1024+1)] {
        assert!(b.prepare(&input).is_err()); assert_eq!(b.doc_state(),before);
    }
    for offset in [2.0, -1.0, 0.5, 4294967296.0] {
        assert!(
            b.capture(&json!({"node":node,"offset":offset,"bias":"right"}).to_string())
                .is_err()
        );
        assert_eq!(b.doc_state(), before);
    }
    assert!(b.history("{\"type\":\"clear\",\"extra\":1}").is_err());
    assert_eq!(b.doc_state(), before);
}
#[test]
fn plans_are_scoped_single_use_and_stale_commits_are_atomic() {
    let mut a = fresh(2);
    let mut b = fresh(3);
    let node = first(&a);
    let at = a
        .capture(&json!({"node":node,"offset":0,"bias":"right"}).to_string())
        .unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let request =
        json!({"kind":"editor","origin":"test","commands":[{"type":"insert","at":at,"text":"x"}]})
            .to_string();
    let p = a.prepare(&request).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let q = a.prepare(&request).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let before = b.doc_state();
    assert!(b.commit(&p).is_err());
    assert_eq!(b.doc_state(), before);
    a.commit(&p).unwrap();
    let before = a.doc_state();
    assert!(a.commit(&p).is_err());
    assert!(a.commit(&q).is_err());
    assert_eq!(a.doc_state(), before);
    assert!(b.resolve(&at).is_err());
    a.release_anchor(&at);
    a.release_anchor(&at);
    assert!(a.resolve(&at).is_err());
}
#[test]
fn handle_tables_have_enforced_limits_and_reusable_capacity() {
    let mut b = fresh(4);
    let node = first(&b);
    let mut tokens = vec![];
    for _ in 0..4096 {
        tokens.push(
            b.capture(&json!({"node":node,"offset":0,"bias":"right"}).to_string())
                .unwrap()["token"]
                .as_str()
                .unwrap()
                .to_string(),
        );
    }
    assert_eq!(
        b.capture(&json!({"node":node,"offset":0,"bias":"right"}).to_string())
            .unwrap_err()
            .code,
        "ResourceLimit"
    );
    b.release_anchor(&tokens[0]);
    assert!(
        b.capture(&json!({"node":node,"offset":0,"bias":"right"}).to_string())
            .is_ok()
    );
    let input = json!({"kind":"editor","origin":"test","commands":[]}).to_string();
    let mut plans = vec![];
    for _ in 0..128 {
        plans.push(
            b.prepare(&input).unwrap()["token"]
                .as_str()
                .unwrap()
                .to_string(),
        );
    }
    assert_eq!(b.prepare(&input).unwrap_err().code, "ResourceLimit");
    b.release_plan(&plans[0]);
    assert!(b.prepare(&input).is_ok());
}
#[test]
fn malformed_creation_does_not_reserve_document_identity() {
    let mut r = json!({"profile":"v5","documentId":"73000000-0000-4000-8000-000000000005","epoch":"74000000-0000-4000-8000-000000000005","nodes":[{"text":""}],"extra":true});
    assert!(Bridge::create(&r.to_string()).is_err());
    r.as_object_mut().unwrap().remove("extra");
    let b = Bridge::create(&r.to_string()).unwrap();
    assert_eq!(b.read().unwrap()["visible"].as_array().unwrap().len(), 1);
    assert!(Bridge::create(&r.to_string()).is_err());
}

#[test]
fn parity_normalization_preserves_literal_content_and_opaque_attributes() {
    let a = json!({"id":"n:11:1","spans":[{"identity":"<11#2>"}],"runs":[{"text":"n:11:1","attributes":{"n:11:1":"<11#2>"}}]});
    let b = json!({"id":"n:22:1","spans":[{"identity":"<22#2>"}],"runs":[{"text":"n:11:1","attributes":{"n:11:1":"<11#2>"}}]});
    assert_eq!(canonical(&a, "11"), canonical(&b, "22"));
    let mut changed = b;
    changed["runs"][0]["text"] = json!("n:22:1");
    assert_ne!(canonical(&a, "11"), canonical(&changed, "22"));
}

#[test]
fn explicitly_empty_creation_is_initialized_without_implicit_defaults() {
    let b=Bridge::create(&json!({"profile":"v5","documentId":"73000000-0000-4000-8000-000000000006","epoch":"74000000-0000-4000-8000-000000000006","nodes":[]}).to_string()).unwrap();
    assert!(b.read().unwrap()["visible"].as_array().unwrap().is_empty());
    assert_eq!(b.read().unwrap()["revision"], 0);
}
