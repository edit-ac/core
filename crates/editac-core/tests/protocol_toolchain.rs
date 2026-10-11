use editac_core::new_document;
use yrs::{GetString, OffsetKind, ReadTxn, Text, Transact};

#[test]
fn factory_uses_utf16_lengths_for_unicode() {
    let doc = new_document();
    assert_eq!(doc.offset_kind(), OffsetKind::Utf16);
    let text = doc.get_or_insert_text("toolchain-fixture");
    let input = "a😀e\u{301}👩\u{200d}💻🇭🇺אב";
    let mut txn = doc.transact_mut();
    text.insert(&mut txn, 0, input);
    assert_eq!(text.len(&txn), input.encode_utf16().count() as u32);
    assert_eq!(text.get_string(&txn), input);
}

#[test]
fn factory_applies_offsets_after_supplementary_characters() {
    let doc = new_document();
    let text = doc.get_or_insert_text("toolchain-fixture");
    let mut txn = doc.transact_mut();
    text.insert(&mut txn, 0, "a😀b");
    text.insert(&mut txn, 3, "!");
    assert_eq!(text.get_string(&txn), "a😀!b");
    text.remove_range(&mut txn, 1, 2);
    assert_eq!(text.get_string(&txn), "a!b");
}

#[test]
fn factory_starts_empty_with_yjs13_client_width() {
    let doc = new_document();
    assert!(doc.client_id().get() <= u32::MAX as u64);
    assert_eq!(doc.transact().root_refs().count(), 0);
}
