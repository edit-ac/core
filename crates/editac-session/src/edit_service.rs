//! Owned preparation/admission boundary shared by human, script and adapter callers.
//! Plans and previews grant no authority: current host policy is checked again at apply.
use crate::{operations::*, ports::LocalCommit, revision::ObservedRevision, session::*};
use editac_core::{
    commands::{
        editor::{EditorCommand, EditorError, PreparedEditorEdit},
        text::TextOrigin,
    },
    document::Document,
    modules::content::Content,
    projection::Snapshot,
};
use editac_markdown::{
    optional::Codecs,
    reconcile::{Conflict, PreparedSourceEdit, SourceBaseline, SourceMode},
};

#[derive(Clone, Copy, Debug)]
pub struct HostPolicy {
    pub writable: bool,
    /// Historical views cannot admit writes or history operations.
    pub history_view: bool,
    pub codecs: Codecs,
    pub references: bool,
    pub extensions: bool,
    pub max_commands: usize,
    pub max_input_bytes: usize,
}
impl Default for HostPolicy {
    fn default() -> Self {
        Self {
            writable: true,
            history_view: false,
            codecs: Codecs::default(),
            references: false,
            extensions: false,
            max_commands: 128,
            max_input_bytes: 1_048_576,
        }
    }
}
#[derive(Clone, Debug)]
pub struct Capabilities {
    pub can_prepare: bool,
    pub can_apply: bool,
    pub can_history: bool,
    pub policy: HostPolicy,
}
pub struct ReadSnapshot {
    pub snapshot: Snapshot,
    pub revision: ObservedRevision,
    pub state: SessionState,
    pub capabilities: Capabilities,
}
#[derive(Debug)]
pub enum ServiceError {
    Session(SessionError),
    Engine(EditorError),
    Source(Conflict),
    ReadOnly,
    HistoryView,
    /// Pre-existing history lacks service capability/limit qualification.
    UnqualifiedHistory,
    UnsupportedModule,
    ResourceLimit,
    Operation(OperationError),
    /// Recoverable exact source inputs and the current semantic snapshot.
    SourceConflict {
        conflict: Conflict,
        base: String,
        proposed: String,
        current: Snapshot,
    },
}
impl From<SessionError> for ServiceError {
    fn from(error: SessionError) -> Self {
        Self::Session(error)
    }
}
impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ServiceError {}

pub struct SourceTarget {
    baseline: SourceBaseline,
    mode: SourceMode,
    request_binding: [u8; 32],
}
impl SourceTarget {
    pub fn source(&self) -> &str {
        self.baseline.source()
    }
}
#[derive(Clone, Copy, Default)]
struct Requirements {
    commands: usize,
    bytes: usize,
    callouts: bool,
    images: bool,
    tables: bool,
    references: bool,
    extensions: bool,
}
impl Requirements {
    fn include(&mut self, other: Self) {
        self.commands = self.commands.max(other.commands).max(1);
        self.bytes = self.bytes.max(other.bytes);
        self.callouts |= other.callouts;
        self.images |= other.images;
        self.tables |= other.tables;
        self.references |= other.references;
        self.extensions |= other.extensions;
    }
}
pub(crate) enum PreparedPlan {
    Commands(PreparedEditorEdit),
    Source(PreparedSourceEdit),
}
/// Opaque and single-use. The host cannot rewrite its expected revision or staged delta.
pub struct PreparedEdit {
    expected: ObservedRevision,
    request_payload: [u8; 32],
    plan: PreparedPlan,
    requirements: Requirements,
    preview: Snapshot,
    engine_origin: String,
}
impl PreparedEdit {
    pub fn preview(&self) -> &Snapshot {
        &self.preview
    }
    pub fn expected_revision(&self) -> &ObservedRevision {
        &self.expected
    }
}

pub struct EditService<S: SessionStore> {
    registry: editac_core::modules::registry::FrozenRegistry,
    session: Session<S>,
    policy: HostPolicy,
    history_requirements: Requirements,
    history_qualified: bool,
    operations: OperationLog,
}
impl<S: SessionStore> EditService<S> {
    pub fn new(session: Session<S>, policy: HostPolicy) -> Self {
        Self::with_registry(session, policy, Default::default())
    }
    pub fn with_registry(
        session: Session<S>,
        policy: HostPolicy,
        registry: editac_core::modules::registry::FrozenRegistry,
    ) -> Self {
        let history = session.document().history_state();
        let history_qualified = history.undo_groups == 0 && history.redo_groups == 0;
        Self {
            registry,
            session,
            policy,
            history_requirements: Requirements::default(),
            history_qualified,
            operations: OperationLog::default(),
        }
    }
    /// Read-only access permits anchors, observations and labeled recovery exports.
    pub fn session(&self) -> &Session<S> {
        &self.session
    }
    pub fn set_policy(&mut self, policy: HostPolicy) {
        self.policy = policy;
    }
    pub fn set_permission(&mut self, permission: CachedPermission) {
        self.session.set_permission(permission);
    }
    /// Host-owned transport lifecycle forwards to this same live session.
    pub fn attach_transport(
        &mut self,
        transport: Box<dyn crate::ports::Transport>,
        expires_at: u64,
        now: u64,
    ) -> Result<(), SessionError> {
        self.session.attach_transport(transport, expires_at, now)
    }
    pub fn detach_transport(&mut self) {
        self.session.detach_transport();
    }
    pub fn flush_pending(&mut self, now: u64) -> Result<usize, SessionError> {
        self.session.flush_pending(now)
    }
    /// Thin forwarding port; cursor/pending/transport admission stay on the Session.
    pub fn flush_pending_page(
        &mut self,
        after: Option<&crate::ports::UpdateId>,
        limit: usize,
        now: u64,
    ) -> Result<usize, SessionError> {
        self.session.flush_pending_page(after, limit, now)
    }
    pub fn accept_receipt(
        &mut self,
        receipt: crate::ports::DurableReceipt,
        now: u64,
    ) -> Result<crate::ports::ReceiptResult, SessionError> {
        self.session.accept_receipt(receipt, now)
    }
    pub fn publish_checkpoint(&mut self) -> Result<crate::ports::PublicationCommit, SessionError> {
        self.session.publish_checkpoint()
    }
    pub fn recover(&mut self) -> Result<(), SessionError> {
        self.session.recover()
    }
    pub fn capabilities(&self, now: u64) -> Capabilities {
        let allowed = self.admit(now).is_ok();
        let editor = self.session.document().identity().has_editor();
        Capabilities {
            can_prepare: allowed && editor,
            can_apply: allowed && editor,
            can_history: allowed && self.history_admit().is_ok(),
            policy: self.policy,
        }
    }
    pub fn read(&self, now: u64) -> Result<ReadSnapshot, ServiceError> {
        Ok(ReadSnapshot {
            snapshot: self
                .session
                .document()
                .snapshot()
                .map_err(|e| ServiceError::Engine(EditorError::Text(e.into())))?,
            revision: self.session.observed_revision()?,
            state: self.session.state(now),
            capabilities: self.capabilities(now),
        })
    }
    /// Coalesced observation of current semantic state, without mutable-engine callbacks.
    /// Peers remain later events; this API makes no complete event-log promise.
    pub fn observe(
        &self,
        previous: &ObservedRevision,
        now: u64,
    ) -> Result<Option<ReadSnapshot>, ServiceError> {
        let current = self.session.observed_revision()?;
        match previous.compare(&current) {
            Ok(()) => Ok(None),
            Err(crate::revision::RevisionError::Stale) => Ok(Some(self.read(now)?)),
            Err(error) => Err(SessionError::Revision(error).into()),
        }
    }
    /// Local durability only. Missing or retired records return None, never a remote claim.
    pub fn local_receipt(
        &self,
        update: &crate::ports::UpdateId,
    ) -> Result<Option<LocalCommit>, ServiceError> {
        Ok(self.session.local_receipt(update)?)
    }
    fn admit(&self, now: u64) -> Result<(), ServiceError> {
        self.session.admit(now)?;
        if !self.policy.writable {
            return Err(ServiceError::ReadOnly);
        }
        if self.policy.history_view {
            return Err(ServiceError::HistoryView);
        }
        Ok(())
    }
    fn requirements(&self, r: Requirements) -> Result<(), ServiceError> {
        if r.commands > self.policy.max_commands.min(4096)
            || r.bytes > self.policy.max_input_bytes.min(1_048_576)
        {
            return Err(ServiceError::ResourceLimit);
        }
        if (r.callouts && !self.policy.codecs.callouts)
            || (r.images && !self.policy.codecs.images)
            || (r.tables && !self.policy.codecs.tables)
            || (r.references && !self.policy.references)
            || (r.extensions && !self.policy.extensions)
        {
            return Err(ServiceError::UnsupportedModule);
        }
        Ok(())
    }
    fn history_admit(&self) -> Result<(), ServiceError> {
        if !self.history_qualified {
            return Err(ServiceError::UnqualifiedHistory);
        }
        self.requirements(self.history_requirements)
    }
    fn replica(&self) -> Result<Document, ServiceError> {
        let checkpoint = self.session.document().checkpoint();
        Document::restore(&checkpoint.identity, &checkpoint, &[])
            .map_err(|e| SessionError::Document(e).into())
    }
    pub fn prepare_commands(
        &self,
        expected: &ObservedRevision,
        commands: &[EditorCommand],
        origin: &TextOrigin,
        now: u64,
    ) -> Result<PreparedEdit, ServiceError> {
        self.admit(now)?;
        self.session.compare_revision(expected)?;
        let mut requirements = Requirements {
            commands: commands.len(),
            ..Requirements::default()
        };
        // Include identifiers, anchors and tuples as well as text. Engine bounds remain authoritative.
        if commands.len() > self.policy.max_commands.min(4096) {
            return Err(ServiceError::ResourceLimit);
        }
        for command in commands {
            requirements.bytes = requirements
                .bytes
                .saturating_add(format!("{command:?}").len());
            match command {
                EditorCommand::CustomMarkAt { .. } | EditorCommand::ExtensionSource { .. } => {
                    requirements.extensions = true
                }
                EditorCommand::Content { content, .. } => match content {
                    Content::Image { .. } => requirements.images = true,
                    Content::Table { .. } | Content::RichTable { .. } => requirements.tables = true,
                    Content::Callout { .. } => requirements.callouts = true,
                    Content::Reference { .. } => requirements.references = true,
                    Content::Asset { .. } => requirements.extensions = true,
                    Content::InertExtension { .. } => {}
                },
                EditorCommand::AtomicContent {
                    expected,
                    replacement,
                    ..
                } => {
                    let old = Content::from_tuple(expected)
                        .map_err(|_| ServiceError::Engine(EditorError::InvalidCommand))?
                        .ok_or(ServiceError::Engine(EditorError::UnsupportedTarget))?;
                    for content in std::iter::once(&old).chain(replacement.iter()) {
                        match content {
                            Content::Image { .. } => requirements.images = true,
                            Content::Reference { .. } => requirements.references = true,
                            Content::InertExtension { .. } | Content::Asset { .. } => {
                                requirements.extensions = true
                            }
                            _ => return Err(ServiceError::Engine(EditorError::UnsupportedTarget)),
                        }
                    }
                }
                EditorCommand::TableCell { .. }
                | EditorCommand::TableStructure { .. }
                | EditorCommand::TableRectangle { .. }
                | EditorCommand::TableAttributes { .. }
                | EditorCommand::TableSource { .. } => requirements.tables = true,
                _ => {}
            }
        }
        self.requirements(requirements)?;
        let plan = self
            .session
            .document()
            .prepare_editor_with_registry(commands, origin, &self.registry)
            .map_err(ServiceError::Engine)?;
        let mut replica = self.replica()?;
        let preview_plan = replica
            .prepare_editor_with_registry(commands, origin, &self.registry)
            .map_err(ServiceError::Engine)?;
        replica
            .commit_editor(preview_plan)
            .map_err(ServiceError::Engine)?;
        let preview = replica
            .snapshot()
            .map_err(|e| ServiceError::Engine(EditorError::Text(e.into())))?;
        for node in &preview.visible {
            for run in &node.runs {
                self.registry
                    .validate_run(&run.text, &run.attributes)
                    .map_err(|_| ServiceError::Engine(EditorError::InvalidCommand))?;
            }
        }
        Ok(PreparedEdit {
            expected: expected.clone(),
            request_payload: crate::receipts::payload_hash(format!(
                "commands-v1:{commands:?}:{}",
                origin.as_str()
            )),
            plan: PreparedPlan::Commands(plan),
            requirements,
            preview,
            engine_origin: origin.as_str().into(),
        })
    }
    /// Shared prepared fragment admission. Codec/module policy is retained and
    /// checked again at apply, just like portable command batches.
    pub fn prepare_fragment(
        &self,
        expected: &ObservedRevision,
        selection: &editac_core::anchors::Selection,
        blocks: &[editac_core::commands::editor::FragmentBlock],
        origin: &TextOrigin,
        now: u64,
    ) -> Result<PreparedEdit, ServiceError> {
        self.prepare_transfer(expected, selection, blocks, None, origin, now)
    }
    pub fn prepare_fragment_move(
        &self,
        expected: &ObservedRevision,
        source: &editac_core::anchors::Selection,
        destination: &editac_core::anchors::Selection,
        origin: &TextOrigin,
        now: u64,
    ) -> Result<PreparedEdit, ServiceError> {
        let blocks = editac_core::transfer::range_blocks(self.session.document(), source)
            .map_err(ServiceError::Engine)?;
        self.prepare_transfer(expected, source, &blocks, Some(destination), origin, now)
    }
    fn prepare_transfer(
        &self,
        expected: &ObservedRevision,
        selection: &editac_core::anchors::Selection,
        blocks: &[editac_core::commands::editor::FragmentBlock],
        destination: Option<&editac_core::anchors::Selection>,
        origin: &TextOrigin,
        now: u64,
    ) -> Result<PreparedEdit, ServiceError> {
        self.admit(now)?;
        self.session.compare_revision(expected)?;
        editac_core::commands::fragment::validate(blocks)
            .map_err(|_| ServiceError::Engine(EditorError::InvalidCommand))?;
        let mut requirements = Requirements {
            commands: blocks.len().max(1),
            ..Requirements::default()
        };
        // Replacing/cutting existing typed content must not bypass a revoked
        // family policy merely because the incoming fragment is plain or empty.
        let selected = editac_core::transfer::range_blocks(self.session.document(), selection)
            .map_err(ServiceError::Engine)?;
        for block in blocks.iter().chain(selected.iter()) {
            requirements.bytes = requirements.bytes.saturating_add(
                editac_core::interchange::transfer_value(block)
                    .to_string()
                    .len(),
            );
            if let Some(editac_core::document::BlockAttributes::Unknown(tuple)) = &block.attributes
            {
                match Content::from_tuple(tuple)
                    .map_err(|_| ServiceError::Engine(EditorError::InvalidCommand))?
                {
                    Some(Content::Image { .. }) => requirements.images = true,
                    Some(Content::Table { .. } | Content::RichTable { .. }) => {
                        requirements.tables = true
                    }
                    Some(Content::Callout { .. }) => requirements.callouts = true,
                    Some(Content::Reference { .. }) => requirements.references = true,
                    Some(Content::Asset { .. }) => requirements.extensions = true,
                    Some(Content::InertExtension { .. }) => {}
                    None => return Err(ServiceError::UnsupportedModule),
                }
            }
        }
        self.requirements(requirements)?;
        let prepare = |document: &Document| match destination {
            Some(destination) => document.prepare_fragment_move(selection, destination, origin),
            None => document.prepare_fragment(selection, blocks, origin),
        };
        let plan = prepare(self.session.document()).map_err(ServiceError::Engine)?;
        let mut replica = self.replica()?;
        let preview_plan = prepare(&replica).map_err(ServiceError::Engine)?;
        replica
            .commit_editor(preview_plan)
            .map_err(ServiceError::Engine)?;
        let preview = replica
            .snapshot()
            .map_err(|e| ServiceError::Engine(EditorError::Text(e.into())))?;
        Ok(PreparedEdit {
            expected: expected.clone(),
            request_payload: crate::receipts::payload_hash(format!(
                "transfer-v1:{selection:?}:{blocks:?}:{destination:?}:{}",
                origin.as_str()
            )),
            plan: PreparedPlan::Commands(plan),
            requirements,
            preview,
            engine_origin: origin.as_str().into(),
        })
    }
    /// Capture exact source-to-owner mapping. URI text or whole-document Markdown is never an identity map.
    pub fn capture_source(
        &self,
        source: &str,
        mode: SourceMode,
        owners: &[String],
        now: u64,
    ) -> Result<SourceTarget, ServiceError> {
        self.admit(now)?;
        self.requirements(source_requirements(
            mode,
            source
                .len()
                .saturating_add(owners.iter().map(String::len).sum::<usize>()),
        ))?;
        let current = self.read(now)?.snapshot;
        let baseline = SourceBaseline::capture(self.session.document(), source, mode, owners)
            .map_err(|conflict| ServiceError::SourceConflict {
                conflict,
                base: source.into(),
                proposed: source.into(),
                current,
            })?;
        Ok(SourceTarget {
            baseline,
            mode,
            request_binding: crate::receipts::payload_parts(&[
                b"source-target-v1",
                source.as_bytes(),
                format!("{mode:?}:{owners:?}").as_bytes(),
            ]),
        })
    }
    pub fn prepare_source(
        &self,
        target: &SourceTarget,
        expected: &ObservedRevision,
        proposed: &str,
        origin: &TextOrigin,
        now: u64,
    ) -> Result<PreparedEdit, ServiceError> {
        self.admit(now)?;
        self.session.compare_revision(expected)?;
        let requirements = source_requirements(
            target.mode,
            target.source().len().saturating_add(proposed.len()),
        );
        self.requirements(requirements)?;
        let current = self.read(now)?.snapshot;
        let conflict = |error| ServiceError::SourceConflict {
            conflict: error,
            base: target.source().into(),
            proposed: proposed.into(),
            current: current.clone(),
        };
        let plan = target
            .baseline
            .prepare(self.session.document(), proposed, origin)
            .map_err(&conflict)?;
        let mut replica = self.replica()?;
        let preview_plan = target
            .baseline
            .prepare(&replica, proposed, origin)
            .map_err(&conflict)?;
        preview_plan.commit(&mut replica).map_err(&conflict)?;
        let preview = replica
            .snapshot()
            .map_err(|e| ServiceError::Engine(EditorError::Text(e.into())))?;
        Ok(PreparedEdit {
            expected: expected.clone(),
            request_payload: crate::receipts::payload_parts(&[
                b"source-v1",
                &target.request_binding,
                proposed.as_bytes(),
                origin.as_str().as_bytes(),
            ]),
            plan: PreparedPlan::Source(plan),
            requirements,
            preview,
            engine_origin: origin.as_str().into(),
        })
    }
    /// Current policy and expected state are checked under the exclusive endpoint owner.
    pub fn apply(
        &mut self,
        prepared: PreparedEdit,
        now: u64,
    ) -> Result<Option<LocalCommit>, ServiceError> {
        let operation_id = self.operations.next().map_err(ServiceError::Operation)?;
        self.apply_as(
            prepared,
            HostOperation {
                actor: None,
                origin: OperationOrigin::Unattributed,
                request_id: format!("endpoint-{operation_id}"),
            },
            now,
        )
    }
    /// Trusted host metadata is supplied at admission, never inferred from a plan.
    pub fn apply_as(
        &mut self,
        prepared: PreparedEdit,
        host: HostOperation,
        now: u64,
    ) -> Result<Option<LocalCommit>, ServiceError> {
        self.admit(now)?;
        self.requirements(prepared.requirements)?;
        self.session.compare_revision(&prepared.expected)?;
        host.validate().map_err(ServiceError::Operation)?;
        let operation_id = self.operations.next().map_err(ServiceError::Operation)?;
        let before = prepared.expected;
        let result = self
            .session
            .apply_prepared_service(&before, prepared.plan, now);
        if matches!(
            &result,
            Ok(Some(_)) | Err(ServiceError::Session(SessionError::Store(_)))
        ) {
            self.history_requirements.include(prepared.requirements);
        }
        self.record(operation_id, host, prepared.engine_origin, before, &result)?;
        result
    }
    /// Freeze a real prepared plan with authenticated host identity. Tokens grant no authority.
    pub fn bind_request(
        &self,
        prepared: PreparedEdit,
        actor: &HostActor,
        request_id: &str,
        expires_at: u64,
    ) -> Result<crate::receipts::RequestProposal, crate::receipts::RequestError> {
        use crate::receipts::*;
        if request_id.is_empty()
            || request_id.len() > 128
            || request_id.chars().any(char::is_control)
        {
            return Err(RequestError::InvalidRequest);
        }
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        hash.update(b"host-request-v1");
        hash.update(prepared.expected.to_bytes());
        hash.update(prepared.request_payload);
        let token = RequestToken {
            actor: actor.subject().into(),
            id: request_id.into(),
            scope: scope_hash(self.session.document().identity()),
            payload: hash.finalize().into(),
        };
        Ok(RequestProposal {
            token,
            prepared,
            expires_at,
        })
    }
    /// Caller authenticates/authorizes document READ before calling. This also enforces actor
    /// and document/epoch isolation. Readonly clients can recover their previous outcome.
    pub fn request_receipt(
        &self,
        actor: &HostActor,
        token: &crate::receipts::RequestToken,
        can_read: bool,
    ) -> Result<Option<crate::receipts::RequestReceipt>, crate::receipts::RequestError> {
        use crate::receipts::*;
        if !can_read {
            return Err(RequestError::Unauthorized);
        }
        authorize(token, actor, self.session.document().identity())?;
        let Some(record) = self.session.request_record(actor.subject(), &token.id)? else {
            if let Some(error) = self.session.pending_request_error(token) {
                return Err(error);
            }
            return Ok(None);
        };
        if !record.key_matches(token) || record.payload != token.payload {
            return Err(RequestError::ChangedPayload);
        }
        Ok(Some(RequestReceipt {
            result: record,
            local: self.session.store_durability(),
        }))
    }
    /// Invoke under the host's serialized owner, with a fresh clock/cancellation observation.
    /// Existing outcomes are resolved before expiry, revision and current write preconditions.
    pub fn apply_request(
        &mut self,
        actor: &HostActor,
        token: &crate::receipts::RequestToken,
        proposal: Option<crate::receipts::RequestProposal>,
        can_read: bool,
        now: u64,
        cancelled: bool,
    ) -> Result<crate::receipts::RequestReceipt, crate::receipts::RequestError> {
        use crate::receipts::*;
        let existing = self.request_receipt(actor, token, can_read)?;
        if proposal
            .as_ref()
            .is_some_and(|proposal| &proposal.token != token)
        {
            return Err(RequestError::ChangedPayload);
        }
        if let Some(receipt) = existing {
            return Ok(receipt);
        }
        let proposal = proposal.ok_or(RequestError::MissingProposal)?;
        if &proposal.token != token {
            return Err(RequestError::ChangedPayload);
        }
        if cancelled {
            return Err(RequestError::Cancelled);
        }
        if now >= proposal.expires_at {
            return Err(RequestError::Expired);
        }
        self.admit(now)?;
        let prepared = proposal.prepared;
        self.requirements(prepared.requirements)?;
        let result = self
            .session
            .apply_request_plan(token, &prepared.expected, prepared.plan, now);
        if result.is_ok() || matches!(result, Err(RequestError::Pending { .. })) {
            self.history_requirements.include(prepared.requirements);
        }
        result
    }
    /// Transport/journal origins remain untrusted. Remote integration never joins typing.
    pub fn receive_peer(
        &mut self,
        entry: crate::ports::JournalEntry,
    ) -> Result<LocalCommit, ServiceError> {
        let before = self.session.observed_revision()?;
        let id = self.operations.next().map_err(ServiceError::Operation)?;
        let engine_origin = entry.origin().to_owned();
        let result = self
            .session
            .receive_peer(entry)
            .map(Some)
            .map_err(ServiceError::Session);
        self.record(
            id,
            HostOperation {
                actor: None,
                origin: OperationOrigin::Replay,
                request_id: format!("endpoint-{id}"),
            },
            engine_origin,
            before,
            &result,
        )?;
        result.map(|commit| commit.unwrap())
    }
    /// Oldest-first bounded records. Eviction/reopen loses provenance, never edits.
    pub fn operations(&self) -> &std::collections::VecDeque<OperationRecord> {
        self.operations.records()
    }
    pub fn operation_bytes(&self) -> usize {
        self.operations.bytes()
    }
    fn record(
        &mut self,
        operation_id: u64,
        host: HostOperation,
        engine_origin: String,
        before: ObservedRevision,
        result: &Result<Option<LocalCommit>, ServiceError>,
    ) -> Result<(), ServiceError> {
        if !matches!(
            result,
            Ok(Some(_)) | Err(ServiceError::Session(SessionError::Store(_)))
        ) {
            return Ok(());
        }
        let after = ObservedRevision::observe(self.session.document())
            .map_err(|e| ServiceError::Session(SessionError::Revision(e)))?;
        if before != after {
            let outcome = match result {
                Ok(Some(commit)) => OperationOutcome::LocalCommit(commit.clone()),
                _ => OperationOutcome::RecoveryRequired,
            };
            self.operations.push(OperationRecord {
                operation_id,
                request_id: host.request_id.into_boxed_str().into_string(),
                actor: host.actor,
                origin: host.origin,
                engine_origin,
                before,
                after,
                outcome,
            });
        }
        Ok(())
    }
    pub fn undo(
        &mut self,
        expected: &ObservedRevision,
        now: u64,
    ) -> Result<Option<LocalCommit>, ServiceError> {
        self.admit(now)?;
        self.history_admit()?;
        self.history_operation(expected, now, false)
    }
    pub fn redo(
        &mut self,
        expected: &ObservedRevision,
        now: u64,
    ) -> Result<Option<LocalCommit>, ServiceError> {
        self.admit(now)?;
        self.history_admit()?;
        self.history_operation(expected, now, true)
    }
    fn history_operation(
        &mut self,
        expected: &ObservedRevision,
        now: u64,
        redo: bool,
    ) -> Result<Option<LocalCommit>, ServiceError> {
        let id = self.operations.next().map_err(ServiceError::Operation)?;
        let result = if redo {
            self.session.redo_if_revision(expected, now)
        } else {
            self.session.undo_if_revision(expected, now)
        }
        .map_err(ServiceError::Session);
        self.record(
            id,
            HostOperation {
                actor: None,
                origin: if redo {
                    OperationOrigin::Redo
                } else {
                    OperationOrigin::Undo
                },
                request_id: format!("endpoint-{id}"),
            },
            if redo { "session:redo" } else { "session:undo" }.into(),
            expected.clone(),
            &result,
        )?;
        result
    }
}
fn source_requirements(mode: SourceMode, bytes: usize) -> Requirements {
    let codecs = match mode {
        SourceMode::Markdown(codecs) => codecs,
        SourceMode::Literal => Codecs::default(),
    };
    Requirements {
        bytes,
        callouts: codecs.callouts,
        images: codecs.images,
        tables: codecs.tables,
        ..Requirements::default()
    }
}
