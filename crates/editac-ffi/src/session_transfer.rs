//! Owned transfer adapter. The engine and EditService retain semantic authority.
use super::*;
use editac_core::{
    anchors::Selection,
    commands::editor::{FragmentBlock, FragmentRun},
    document::BlockAttributes,
    interchange::{TransferBlock, transfer_blocks, transfer_value},
};
use editac_diff::representation::ContentHash;
use serde_json::{Value, json};
const LIMIT: usize = 1_048_576;
static NEXT_SOURCE: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeTransferRange {
    pub anchor: String,
    pub focus: String,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeTransferInput {
    pub fragment_json: Option<String>,
    pub markdown: Option<String>,
    pub html: Option<String>,
    pub plain_text: Option<String>,
    pub literal: bool,
}
/// Process-local provenance, never writable by a consumer or a clipboard payload.
#[derive(Debug, uniffi::Object)]
pub struct NativeTransferSource {
    id: u64,
    session: DocumentIdentity,
    hash: ContentHash,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeTransferExport {
    pub revision: Vec<u8>,
    pub fragment_json: String,
    pub markdown: String,
    pub plain_text: String,
    pub diagnostics: Vec<String>,
    pub source: Arc<NativeTransferSource>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativePreparedTransfer {
    pub token: String,
    pub diagnostics: Vec<String>,
    /// Retain every original flavor for unsupported-codec recovery; never executed.
    pub source: Option<NativeTransferInput>,
    pub exported: Option<NativeTransferExport>,
}
/// Only produced after a nonempty, durable destination Session commit. Opaque
/// provenance binds the exact exported payload and captured source operation.
#[derive(Debug, uniffi::Object)]
pub struct NativeTransferReceipt {
    source_id: u64,
    destination: DocumentIdentity,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeTransferCommit {
    pub commit: Option<NativeSessionCommit>,
    pub destination_receipt: Option<Arc<NativeTransferReceipt>>,
}
pub(super) struct TransferPlan {
    plan: PreparedEdit,
    kind: TransferKind,
}
enum TransferKind {
    Paste(Option<Arc<NativeTransferSource>>),
    Cut(Arc<NativeTransferSource>),
    Move,
}
fn invalid(message: &str) -> NativeSessionError {
    NativeSessionError::CommandInput {
        message: format!("transfer: {message}"),
    }
}
fn canonical(blocks: &[FragmentBlock], schema: &str) -> Result<String> {
    let raw = json!({"version":1,"schema":schema,"blocks":blocks.iter().map(transfer_value).collect::<Vec<_>>()}).to_string();
    editac_core::clipboard::validate(&raw, schema).map_err(invalid)?;
    Ok(raw)
}
fn empty() -> Vec<FragmentBlock> {
    vec![FragmentBlock {
        runs: vec![FragmentRun {
            text: String::new(),
            marks: vec![],
        }],
        attributes: None,
        containers: vec![],
        checked: None,
    }]
}
fn literal(text: &str, in_code: bool) -> Vec<FragmentBlock> {
    let lines: Vec<_> = if in_code {
        vec![text]
    } else {
        text.split('\n').collect()
    };
    lines
        .into_iter()
        .map(|text| FragmentBlock {
            runs: vec![FragmentRun {
                text: text.into(),
                marks: vec![],
            }],
            attributes: None,
            containers: vec![],
            checked: None,
        })
        .collect()
}
impl State {
    fn transfer_selection(&self, range: &NativeTransferRange) -> Result<Selection> {
        Ok(Selection {
            anchor: self
                .anchors
                .get(&range.anchor)
                .ok_or(NativeSessionError::InvalidAnchor)?
                .clone(),
            focus: self
                .anchors
                .get(&range.focus)
                .ok_or(NativeSessionError::InvalidAnchor)?
                .clone(),
        })
    }
    fn export_transfer(
        &self,
        revision: &[u8],
        range: &NativeTransferRange,
        now: u64,
    ) -> Result<NativeTransferExport> {
        let read = self.service.read(now)?;
        self.service
            .session()
            .compare_revision(&ObservedRevision::from_bytes(revision)?)?;
        let selection = self.transfer_selection(range)?;
        let document = self.service.session().document();
        let blocks = editac_core::transfer::range_blocks(document, &selection)
            .map_err(ServiceError::Engine)?;
        let fragment_json = canonical(&blocks, &document.identity().schema)?;
        let exported = editac_markdown::export::export(&blocks);
        let plain_text = blocks
            .iter()
            .map(|b| b.runs.iter().map(|r| r.text.as_str()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        if exported.markdown.len() > LIMIT || plain_text.len() > LIMIT {
            return Err(NativeSessionError::ResourceLimit);
        }
        let id = NEXT_SOURCE
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| NativeSessionError::ResourceLimit)?;
        Ok(NativeTransferExport {
            revision: read.revision.to_bytes().to_vec(),
            source: Arc::new(NativeTransferSource {
                id,
                session: document.identity().clone(),
                hash: ContentHash::of(fragment_json.as_bytes()),
            }),
            fragment_json,
            markdown: exported.markdown,
            plain_text,
            diagnostics: exported.diagnostics.iter().map(|d| d.code.into()).collect(),
        })
    }
    fn retain_transfer(&mut self, plan: PreparedEdit, kind: TransferKind) -> Result<String> {
        if self.transfers.len() >= 128 {
            return Err(NativeSessionError::ResourceLimit);
        }
        let token = self.retain_plan(plan)?;
        let plan = self
            .plans
            .remove(&token)
            .ok_or(NativeSessionError::InvalidPlan)?;
        self.transfers
            .insert(token.clone(), TransferPlan { plan, kind });
        Ok(token)
    }
}
#[uniffi::export]
impl NativeSession {
    pub fn export_transfer(
        &self,
        revision: Vec<u8>,
        range: NativeTransferRange,
        now: u64,
    ) -> Result<NativeTransferExport> {
        self.call(move |state| state.export_transfer(&revision, &range, now))
    }
    pub fn prepare_paste(
        &self,
        revision: Vec<u8>,
        range: NativeTransferRange,
        input: NativeTransferInput,
        source: Option<Arc<NativeTransferSource>>,
        now: u64,
    ) -> Result<NativePreparedTransfer> {
        self.call(move |state| {
            let size = [
                &input.fragment_json,
                &input.markdown,
                &input.html,
                &input.plain_text,
            ]
            .into_iter()
            .flatten()
            .try_fold(0usize, |n, s| n.checked_add(s.len()))
            .ok_or(NativeSessionError::ResourceLimit)?;
            if size > LIMIT {
                return Err(NativeSessionError::ResourceLimit);
            }
            let selection = state.transfer_selection(&range)?;
            let schema = &state.service.session().document().identity().schema;
            let document = state.service.session().document();
            let position = match document
                .resolve_anchor(&selection.anchor)
                .map_err(|_| invalid("target"))?
            {
                Resolution::Position(p) => p,
                _ => return Err(invalid("target")),
            };
            let target = document
                .fragment_for_node(&position.node)
                .map_err(ServiceError::Engine)?;
            let mut offset = 0;
            let in_code = matches!(target.attributes, Some(BlockAttributes::Code(_)))
                || target.runs.iter().any(|r| {
                    let end = offset + r.text.encode_utf16().count() as u32;
                    let at = position.offset.0 >= offset && position.offset.0 <= end;
                    offset = end;
                    at && r
                        .marks
                        .iter()
                        .any(|(m, _)| *m == editac_core::commands::format::Mark::Code)
                });
            let mut diagnostics = vec![];
            let mut exact = false;
            let mut blocks = None;
            if !input.literal && !in_code {
                if let Some(raw) = &input.fragment_json {
                    let decoded = (|| {
                        editac_core::clipboard::validate(raw, schema).map_err(invalid)?;
                        let value: Value =
                            serde_json::from_str(raw).map_err(|_| invalid("fragment"))?;
                        let wire: Vec<TransferBlock> =
                            serde_json::from_value(value["blocks"].clone())
                                .map_err(|_| invalid("fragment"))?;
                        transfer_blocks(wire).map_err(|_| invalid("fragment semantics"))
                    })();
                    match decoded {
                        Ok(value) => {
                            blocks = Some(value);
                            exact = true;
                        }
                        Err(_) => diagnostics.push("internal-fragment-rejected".into()),
                    }
                }
                if blocks.is_none() {
                    if let Some(markdown) = &input.markdown {
                        let parsed = editac_markdown::optional::import_with_codecs(
                            markdown,
                            state.service.capabilities(now).policy.codecs,
                        )
                        .map_err(|_| invalid("markdown"))?;
                        diagnostics.extend(parsed.diagnostics.iter().map(|d| d.code.into()));
                        blocks = Some(parsed.blocks);
                    }
                }
                if blocks.is_none() && input.html.is_some() {
                    diagnostics.push("html-codec-unavailable-source-preserved".into());
                }
            }
            let blocks = match blocks {
                Some(blocks) => blocks,
                None => literal(
                    input
                        .plain_text
                        .as_deref()
                        .ok_or_else(|| invalid("no supported flavor; source retained by caller"))?,
                    in_code,
                ),
            };
            let provenance = if exact {
                if let Some(source) = source {
                    if ContentHash::of(canonical(&blocks, schema)?.as_bytes()) != source.hash {
                        return Err(invalid("source payload mismatch"));
                    }
                    Some(source)
                } else {
                    None
                }
            } else {
                None
            };
            let plan = state.service.prepare_fragment(
                &ObservedRevision::from_bytes(&revision)?,
                &selection,
                &blocks,
                &TextOrigin::new("clipboard:paste").map_err(|_| invalid("origin"))?,
                now,
            )?;
            let token = state.retain_transfer(plan, TransferKind::Paste(provenance))?;
            Ok(NativePreparedTransfer {
                token,
                diagnostics,
                source: Some(input),
                exported: None,
            })
        })
    }
    pub fn prepare_cut(
        &self,
        revision: Vec<u8>,
        range: NativeTransferRange,
        now: u64,
    ) -> Result<NativePreparedTransfer> {
        self.call(move |state| {
            let exported = state.export_transfer(&revision, &range, now)?;
            let selection = state.transfer_selection(&range)?;
            let plan = state.service.prepare_fragment(
                &ObservedRevision::from_bytes(&revision)?,
                &selection,
                &empty(),
                &TextOrigin::new("clipboard:cut").map_err(|_| invalid("origin"))?,
                now,
            )?;
            let token = state.retain_transfer(plan, TransferKind::Cut(exported.source.clone()))?;
            Ok(NativePreparedTransfer {
                token,
                diagnostics: exported.diagnostics.clone(),
                source: None,
                exported: Some(exported),
            })
        })
    }
    pub fn prepare_transfer_move(
        &self,
        revision: Vec<u8>,
        source: NativeTransferRange,
        destination: NativeTransferRange,
        now: u64,
    ) -> Result<NativePreparedTransfer> {
        self.call(move |state| {
            let source = state.transfer_selection(&source)?;
            let destination = state.transfer_selection(&destination)?;
            let plan = state.service.prepare_fragment_move(
                &ObservedRevision::from_bytes(&revision)?,
                &source,
                &destination,
                &TextOrigin::new("clipboard:move").map_err(|_| invalid("origin"))?,
                now,
            )?;
            let token = state.retain_transfer(plan, TransferKind::Move)?;
            Ok(NativePreparedTransfer {
                token,
                diagnostics: vec![],
                source: None,
                exported: None,
            })
        })
    }
    /// Ordinary paste never deletes a source. For cut, acknowledge the clipboard;
    /// for cross-document deletion, supply an opaque qualified destination receipt.
    /// Every attempt consumes the plan, including rejected or stale admission.
    pub fn commit_transfer(
        &self,
        token: String,
        clipboard_acknowledged: bool,
        destination_receipt: Option<Arc<NativeTransferReceipt>>,
        now: u64,
    ) -> Result<NativeTransferCommit> {
        self.call(move |state| {
            let transfer = state
                .transfers
                .remove(&token)
                .ok_or(NativeSessionError::InvalidPlan)?;
            if let TransferKind::Cut(source) = &transfer.kind {
                if let Some(receipt) = destination_receipt {
                    if receipt.source_id != source.id || receipt.destination == source.session {
                        return Err(invalid("unqualified destination receipt"));
                    }
                } else if !clipboard_acknowledged {
                    return Err(invalid("clipboard acknowledgement required"));
                }
            } else if destination_receipt.is_some() {
                return Err(invalid("receipt only qualifies source deletion"));
            }
            let commit = state.service.apply(transfer.plan, now)?;
            let receipt = match (&transfer.kind, &commit) {
                (TransferKind::Paste(Some(source)), Some(commit))
                    if commit.durability == Durability::ProcessCrash =>
                {
                    Some(Arc::new(NativeTransferReceipt {
                        source_id: source.id,
                        destination: state.service.session().document().identity().clone(),
                    }))
                }
                _ => None,
            };
            Ok(NativeTransferCommit {
                commit: commit.map(Into::into),
                destination_receipt: receipt,
            })
        })
    }
    /// Trusted host registration of the existing callout codec. No resolver or
    /// network authority; retained transfers recheck this setting at admission.
    pub fn set_callout_policy(&self, enabled: bool) -> Result<()> {
        self.call(move |state| {
            let mut policy = state.service.capabilities(0).policy;
            policy.codecs.callouts = enabled;
            state.service.set_policy(policy);
            Ok(())
        })
    }
    pub fn cancel_transfer(&self, token: String) -> Result<()> {
        self.call(move |state| {
            state.transfers.remove(&token);
            Ok(())
        })
    }
}
