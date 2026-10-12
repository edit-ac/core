//! Full production editor matrix under the explicit v5 envelope.
#[path = "../../../fixtures/schema-v5/mapping.rs"]
#[allow(dead_code)]
mod m;
use editac_core::document::{DocumentError, DocumentIdentity};
const EXCHANGE_ENV: &str = "EDITAC_STABLE_EDITOR_EXCHANGE";
const EXCHANGE_SCRIPT: &str = "fixtures/schema-v5/editor-exchange.mjs";
fn profile_identity(
    document: impl Into<String>,
    epoch: impl Into<String>,
) -> Result<DocumentIdentity, DocumentError> {
    DocumentIdentity::v5(document, epoch)
}
fn identity() -> DocumentIdentity {
    profile_identity(
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
    )
    .unwrap()
}
#[path = "support/editor_cases.rs"]
mod cases;
