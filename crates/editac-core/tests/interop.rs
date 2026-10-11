//! Disposable cross-language XML fixture: binary receipt proves no durability.
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use yrs::{
    Any, Doc, OffsetKind, Options, Out, ReadTxn, StateVector, Text, Transact, Update, Xml,
    XmlElementPrelim, XmlFragment, XmlTextPrelim, XmlTextRef,
    updates::{decoder::Decode, encoder::Encode},
};

const INPUT: &str = "a😀b e\u{301}👩\u{200d}💻🇭🇺אב";
const ORDERS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];
fn replica(id: u64) -> Doc {
    // Fixed IDs only for disposable fixtures; production factory generates fresh IDs.
    Doc::with_options(Options {
        client_id: yrs::block::ClientID::new(id),
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}
fn bridge(mode: &str, dir: &Path) {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/interop/bridge.mjs");
    let output = Command::new("node")
        .arg(script)
        .arg(mode)
        .arg(dir)
        .output()
        .expect("Node installed");
    assert!(
        output.status.success(),
        "bridge {mode}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn apply(doc: &Doc, path: PathBuf) {
    let bytes = fs::read(path).unwrap();
    doc.transact_mut()
        .apply_update(Update::decode_v1(&bytes).unwrap())
        .unwrap();
}
fn text(doc: &Doc) -> XmlTextRef {
    let root = doc.get_or_insert_xml_fragment("interop");
    let txn = doc.transact();
    assert_eq!(root.len(&txn), 1);
    let element = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
    assert_eq!(element.tag().as_ref(), "p");
    assert_eq!(element.len(&txn), 1);
    element.get(&txn, 0).unwrap().into_xml_text().unwrap()
}
fn assert_semantics(doc: &Doc) {
    let root = doc.get_or_insert_xml_fragment("interop");
    let text = text(doc);
    let txn = doc.transact();
    let element = root.get(&txn, 0).unwrap().into_xml_element().unwrap();
    assert_eq!(
        element.get_attribute(&txn, "id"),
        Some(Out::Any("fixture-block".into()))
    );
    assert_eq!(
        element.get_attribute(&txn, "stage"),
        Some(Out::Any("edited".into()))
    );
    let diff = text.diff(&txn, |_| ());
    let expected = [
        ("a", None),
        ("😀", Some("bold")),
        ("!", Some("italic")),
        (&INPUT[6..], None),
    ];
    assert_eq!(diff.len(), expected.len());
    for (part, (content, mark)) in diff.iter().zip(expected) {
        assert_eq!(part.insert, Out::Any(content.into()));
        match mark {
            Some(mark) => {
                let attrs = part.attributes.as_ref().unwrap();
                assert_eq!(attrs.len(), 1);
                assert_eq!(attrs.get(mark), Some(&Any::Bool(true)));
            }
            None => assert!(part.attributes.as_ref().is_none_or(|a| a.is_empty())),
        }
    }
    assert_eq!(
        text.len(&txn),
        "a😀! e\u{301}👩\u{200d}💻🇭🇺אב".encode_utf16().count() as u32
    );
}
struct Temporary(PathBuf, bool);
impl Drop for Temporary {
    fn drop(&mut self) {
        if self.1 {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
#[test]
fn binary_v1_xml_exchange_in_both_directions() {
    let external = std::env::var_os("EDITAC_INTEROP_OUTPUT");
    let dir = Temporary(
        external.clone().map(PathBuf::from).unwrap_or_else(|| {
            std::env::temp_dir().join(format!("editac-interop-{}", std::process::id()))
        }),
        external.is_none(),
    );
    fs::create_dir_all(&dir.0).unwrap();
    bridge("generate-js", &dir.0);
    for order in ORDERS {
        let doc = replica(202);
        for i in order {
            for _ in 0..2 {
                apply(&doc, dir.0.join(format!("js-{i}.bin")));
            }
        }
        assert_semantics(&doc);
        let vector = doc.transact().state_vector();
        let expected =
            StateVector::decode_v1(&fs::read(dir.0.join("js-sv-2.bin")).unwrap()).unwrap();
        assert_eq!(vector, expected);
        for i in order.into_iter().rev() {
            apply(&doc, dir.0.join(format!("js-{i}.bin")));
        }
        assert_semantics(&doc);
        assert_eq!(doc.transact().state_vector(), vector);
    }
    let doc = replica(202);
    let root = doc.get_or_insert_xml_fragment("interop");
    let xml;
    {
        let mut txn = doc.transact_mut();
        let element = root.insert(&mut txn, 0, XmlElementPrelim::empty("p"));
        element.insert_attribute(&mut txn, "id", "fixture-block");
        xml = element.insert(&mut txn, 0, XmlTextPrelim::new(INPUT));
        xml.format(
            &mut txn,
            1,
            2,
            HashMap::from([("bold".into(), Any::Bool(true))]),
        );
    }
    fs::write(
        dir.0.join("rust-0.bin"),
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default()),
    )
    .unwrap();
    fs::write(
        dir.0.join("rust-sv-0.bin"),
        doc.transact().state_vector().encode_v1(),
    )
    .unwrap();
    let sv = doc.transact().state_vector();
    xml.insert_with_attributes(
        &mut doc.transact_mut(),
        3,
        "!",
        HashMap::from([("italic".into(), Any::Bool(true))]),
    );
    fs::write(
        dir.0.join("rust-1.bin"),
        doc.transact().encode_state_as_update_v1(&sv),
    )
    .unwrap();
    let sv = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        xml.remove_range(&mut txn, 4, 1);
        root.get(&txn, 0)
            .unwrap()
            .into_xml_element()
            .unwrap()
            .insert_attribute(&mut txn, "stage", "edited");
    }
    fs::write(
        dir.0.join("rust-2.bin"),
        doc.transact().encode_state_as_update_v1(&sv),
    )
    .unwrap();
    assert_semantics(&doc);
    bridge("verify-rust", &dir.0);
    // Rust uses a JS vector to send only the missing operations from the JS writer.
    let peer = replica(505);
    apply(&peer, dir.0.join("js-0.bin"));
    let sender = replica(606);
    apply(&sender, dir.0.join("js-full.bin"));
    let sv = StateVector::decode_v1(&fs::read(dir.0.join("js-sv-0.bin")).unwrap()).unwrap();
    let delta = sender.transact().encode_state_as_update_v1(&sv);
    fs::write(dir.0.join("rust-for-js.bin"), &delta).unwrap();
    peer.transact_mut()
        .apply_update(Update::decode_v1(&delta).unwrap())
        .unwrap();
    assert_semantics(&peer);
    // JS uses a Rust vector to encode a new local edit; Rust consumes that diff.
    bridge("delta-for-rust", &dir.0);
    let peer = replica(707);
    apply(&peer, dir.0.join("rust-0.bin"));
    apply(&peer, dir.0.join("js-for-rust.bin"));
    let xml = text(&peer);
    let txn = peer.transact();
    let diff = xml.diff(&txn, |_| ());
    assert_eq!(diff[2].insert, Out::Any("?".into()));
    assert_eq!(
        diff[2].attributes.as_ref().unwrap().get("underline"),
        Some(&Any::Bool(true))
    );
    assert_eq!(
        txn.state_vector(),
        StateVector::decode_v1(&fs::read(dir.0.join("js-for-rust-sv.bin")).unwrap()).unwrap()
    );
}
