//! Exact V1 checkpoint comparison without a second full output buffer.
//!
//! This private sink mirrors the pinned Yrs EncoderV1 wire operations, using
//! Yrs' own primitive/Any writers. It is not a hash or an encoded-size estimate.
//! Keep the independent EncoderV1 oracle when changing Yrs or this sink.
use yrs::encoding::write::Write;
use yrs::updates::encoder::Encoder;
use yrs::{Any, ClientID, Doc, ID, ReadTxn, StateVector, Transact};

pub(crate) fn matches(doc: &Doc, expected: &[u8]) -> bool {
    let tx = doc.transact();
    // The convenience V1 API merges pending data after encoding the store.
    // Admitted editor replicas have none; never compare a partial store if a
    // raw/internal writer has introduced pending inserts or deletes.
    if tx.store().pending_update().is_some() || tx.store().pending_ds().is_some() {
        return tx.encode_state_as_update_v1(&StateVector::default()) == expected;
    }
    let mut sink = Comparison::new(expected);
    tx.encode_state_as_update(&StateVector::default(), &mut sink);
    sink.matches()
}

struct Comparison<'a> {
    expected: &'a [u8],
    position: usize,
    equal: bool,
}
impl<'a> Comparison<'a> {
    fn new(expected: &'a [u8]) -> Self {
        Self {
            expected,
            position: 0,
            equal: true,
        }
    }
    fn matches(&self) -> bool {
        self.equal && self.position == self.expected.len()
    }
    fn write_id(&mut self, id: &ID) {
        self.write_var(id.client.get());
        self.write_var(id.clock);
    }
}
impl Write for Comparison<'_> {
    fn write_all(&mut self, bytes: &[u8]) {
        let end = self.position.saturating_add(bytes.len());
        self.equal &= self.expected.get(self.position..end) == Some(bytes);
        self.position = end;
    }
    fn write_u8(&mut self, byte: u8) {
        self.equal &= self.expected.get(self.position) == Some(&byte);
        self.position = self.position.saturating_add(1);
    }
}
impl Encoder for Comparison<'_> {
    fn to_vec(self) -> Vec<u8> {
        // Only encode_state_as_update (not its allocating convenience method)
        // consumes this private sink. No output bytes are retained.
        unreachable!("checkpoint comparison cannot produce an output buffer")
    }
    fn reset_ds_cur_val(&mut self) {}
    fn write_ds_clock(&mut self, clock: u32) {
        self.write_var(clock);
    }
    fn write_ds_len(&mut self, len: u32) {
        self.write_var(len);
    }
    fn write_left_id(&mut self, id: &ID) {
        self.write_id(id);
    }
    fn write_right_id(&mut self, id: &ID) {
        self.write_id(id);
    }
    fn write_client(&mut self, client: ClientID) {
        self.write_var(client.get());
    }
    fn write_info(&mut self, info: u8) {
        self.write_u8(info);
    }
    fn write_parent_info(&mut self, key: bool) {
        self.write_var(u32::from(key));
    }
    fn write_type_ref(&mut self, info: u8) {
        self.write_u8(info);
    }
    fn write_len(&mut self, len: u32) {
        self.write_var(len);
    }
    fn write_any(&mut self, any: &Any) {
        any.encode(self);
    }
    fn write_json(&mut self, any: &Any) {
        let mut json = String::new();
        any.to_json(&mut json);
        self.write_string(&json);
    }
    fn write_key(&mut self, key: &str) {
        self.write_string(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::updates::encoder::EncoderV1;
    use yrs::{Map, Text};

    fn operations<E: Encoder>(encoder: &mut E) {
        encoder.reset_ds_cur_val();
        encoder.write_ds_clock(u32::MAX);
        encoder.write_ds_len(128);
        encoder.write_left_id(&ID::new(ClientID::new(7), 127));
        encoder.write_right_id(&ID::new(ClientID::new(129), 16384));
        encoder.write_client(ClientID::new(42));
        encoder.write_info(255);
        encoder.write_parent_info(true);
        encoder.write_parent_info(false);
        encoder.write_type_ref(10);
        encoder.write_len(u32::MAX);
        encoder.write_key("nested\"\\\n😀界");
        for any in [
            Any::Undefined,
            Any::Null,
            Any::Bool(true),
            Any::Bool(false),
            Any::from(-0.25),
            Any::from(f64::INFINITY),
            Any::from(i64::MIN),
            Any::from("😀\n\\\""),
            Any::Buffer(vec![0, 127, 255].into()),
            Any::Array(vec![Any::Null, Any::from(9007199254740991.0)].into()),
            Any::Map(std::collections::HashMap::from([("界".into(), Any::Bool(true))]).into()),
        ] {
            encoder.write_any(&any);
        }
        encoder.write_json(&Any::Array(vec![Any::from("😀\n\\\""), Any::Null].into()));
        encoder.write_all(&[0, 255]);
    }

    #[test]
    fn comparison_matches_independent_v1_encoder_and_rejects_every_corruption() {
        let mut oracle = EncoderV1::new();
        operations(&mut oracle);
        let bytes = oracle.to_vec();
        let check = |expected: &[u8]| {
            let mut sink = Comparison::new(expected);
            operations(&mut sink);
            sink.matches()
        };
        assert!(check(&bytes));
        assert!(!check(&[]));
        for i in 0..bytes.len() {
            let mut wrong = bytes.clone();
            wrong[i] ^= 1;
            assert!(!check(&wrong), "corrupt byte {i}");
            assert!(!check(&bytes[..i]), "truncated at {i}");
        }
        let mut extra = bytes;
        extra.push(0);
        assert!(!check(&extra));
    }

    #[test]
    fn checkpoint_comparison_preserves_delete_gc_and_pending_encoding() {
        use yrs::updates::decoder::Decode;
        for skip_gc in [false, true] {
            let doc = Doc::with_options(yrs::Options {
                client_id: ClientID::new(17),
                skip_gc,
                ..Default::default()
            });
            let text = doc.get_or_insert_text("text");
            let map = doc.get_or_insert_map("map");
            text.insert(&mut doc.transact_mut(), 0, "A😀界Z");
            map.insert(
                &mut doc.transact_mut(),
                "json",
                Any::Array(vec![Any::Null, Any::from("escaped\n\"")].into()),
            );
            let before = doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            assert!(matches(&doc, &before));
            text.remove_range(&mut doc.transact_mut(), 0, 1);
            assert!(!matches(&doc, &before));
            let after = doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            assert!(matches(&doc, &after));
            let source = Doc::with_client_id(31);
            let remote = source.get_or_insert_text("remote");
            remote.insert(&mut source.transact_mut(), 0, "base");
            let sv = source.transact().state_vector();
            remote.insert(&mut source.transact_mut(), 4, "pending");
            let delta = source.transact().encode_state_as_update_v1(&sv);
            doc.transact_mut()
                .apply_update(yrs::Update::decode_v1(&delta).unwrap())
                .unwrap();
            assert!(doc.transact().store().pending_update().is_some());
            let pending = doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            assert!(matches(&doc, &pending));
            assert!(!matches(&doc, &after));
        }
    }
}
