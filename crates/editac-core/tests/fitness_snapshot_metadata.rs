//! Compare indexed serialization with the prior independent scan/count oracle.
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
use std::collections::BTreeMap;
use yrs::Any;

fn kind(value: &Any) -> &str {
    match value {
        Any::Array(a) => match a.first() {
            Some(Any::String(s)) => s,
            _ => "",
        },
        _ => "",
    }
}
fn numbered(owner: &m::Owner) -> bool {
    owner.kind == "block"
        && !owner.spans.is_empty()
        && matches!(kind(&owner.attrs), "paragraph" | "heading" | "code")
}
fn check_metadata(owners: Vec<m::Owner>, doc: &yrs::Doc) {
    let view = m::View {
        owners,
        outcomes: BTreeMap::new(),
        retained: BTreeMap::new(),
        sources: BTreeMap::new(),
    };
    let snapshot = m::snapshot_from_view(doc, view.clone()).unwrap();
    let Any::Map(snapshot) = snapshot else {
        panic!()
    };
    let mut actual = BTreeMap::new();
    for key in ["visible", "deleted"] {
        let Any::Array(nodes) = &snapshot[key] else {
            panic!()
        };
        for node in nodes.iter() {
            let Any::Map(node) = node else { panic!() };
            let Any::String(id) = &node["id"] else {
                panic!()
            };
            actual.insert(id.to_string(), node);
        }
    }
    for owner in &view.owners {
        let parent = view.owners.iter().find(|p| p.id == owner.parent);
        let number = if let Some(p) = parent.filter(|p| kind(&p.attrs) == "ordered") {
            if numbered(owner) && !owner.deleted {
                let Any::Array(a) = &p.attrs else { panic!() };
                let start = serde_json::from_str::<serde_json::Value>(&m::json(&a[1]))
                    .unwrap()
                    .as_u64()
                    .unwrap() as u32;
                Any::from(
                    start
                        + view
                            .owners
                            .iter()
                            .take_while(|p| p.id != owner.id)
                            .filter(|p| p.parent == owner.parent && !p.deleted && numbered(p))
                            .count() as u32,
                )
            } else {
                Any::Null
            }
        } else {
            Any::Null
        };
        let checked = if numbered(owner) && parent.is_some_and(|p| kind(&p.attrs) == "checklist") {
            // Every third generated owner has a true check record, others false/missing.
            Any::Bool(
                owner
                    .id
                    .strip_prefix("n:99:")
                    .and_then(|s| s.parse::<usize>().ok())
                    .is_some_and(|n| n % 3 == 0),
            )
        } else {
            Any::Null
        };
        assert_eq!(
            actual[&owner.id]["number"], number,
            "number for {}",
            owner.id
        );
        assert_eq!(
            actual[&owner.id]["check"], checked,
            "check for {}",
            owner.id
        );
        assert_eq!(actual[&owner.id]["parent"], Any::from(owner.parent.clone()));
    }
    assert_eq!(actual.len(), view.owners.len());
}

#[test]
fn indexed_metadata_matches_scan_oracle_for_nested_interleaved_deleted_and_unknown_owners() {
    let doc = m::seed();
    let seed = m::project(&doc).unwrap();
    let spans = seed
        .owners
        .iter()
        .find(|o| !o.spans.is_empty())
        .unwrap()
        .spans
        .clone();
    let mut owners = vec![];
    for (i, tuple) in [
        m::arr(vec![Any::from("ordered"), Any::from(7)]),
        m::arr(vec![Any::from("checklist")]),
        m::arr(vec![Any::from("ordered"), Any::from(41)]),
        m::arr(vec![Any::from("unordered")]),
        m::arr(vec![Any::from("quote")]),
    ]
    .into_iter()
    .enumerate()
    {
        owners.push(m::Owner {
            id: format!("c:99:{i}"),
            version: "base".into(),
            parent: if i == 2 {
                "c:99:0".into()
            } else {
                "@root".into()
            },
            kind: if i == 4 {
                "quote".into()
            } else {
                "list".into()
            },
            spans: vec![],
            deleted: i == 3,
            attrs: tuple,
        });
    }
    for i in 0..384 {
        let id = format!("n:99:{i}");
        if i % 3 != 2 {
            m::set(
                &doc,
                8,
                &id,
                m::arr(vec![Any::from("check"), Any::Bool(i % 3 == 0)]),
            );
        }
        let tuple = match i % 6 {
            0 => m::arr(vec![Any::from("paragraph")]),
            1 => m::arr(vec![Any::from("heading"), Any::from(2)]),
            2 => m::arr(vec![Any::from("code"), Any::from("rust")]),
            3 => m::arr(vec![Any::from("separator")]),
            _ => m::arr(vec![Any::from("unknown-extension"), Any::from("preserve")]),
        };
        owners.push(m::Owner {
            id,
            version: "base".into(),
            parent: if i % 7 == 6 {
                "@root".into()
            } else {
                format!("c:99:{}", i % 5)
            },
            kind: "block".into(),
            spans: if i % 11 == 0 { vec![] } else { spans.clone() },
            deleted: i % 4 == 0,
            attrs: tuple,
        });
    }
    check_metadata(owners.clone(), &doc);
    // Reordering changes the sibling ordinal oracle; containers can follow children.
    owners.reverse();
    check_metadata(owners, &doc);
}

#[test]
fn empty_and_flat_metadata_keep_null_check_and_number() {
    let doc = m::seed();
    check_metadata(vec![], &doc);
    let mut owners = m::project(&doc).unwrap().owners;
    for o in &mut owners {
        o.parent = "@root".into();
    }
    check_metadata(owners, &doc);
}
