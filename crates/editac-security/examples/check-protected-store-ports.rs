//! Compile-only portable contract probe, never a runtime/platform qualification.
#![allow(dead_code)]
#[path = "../src/keys.rs"]
mod keys;
#[path = "../src/store.rs"]
mod store;

fn main() {}
