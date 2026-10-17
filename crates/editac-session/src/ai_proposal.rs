//! Optional AI review adapter. Streams are ephemeral; only existing Session review may edit.
use crate::{
    edit_service::{EditService, ServiceError},
    operations::HostOperation,
    ports::LocalCommit,
    review_apply::{Acceptance, ReviewError, ReviewTarget},
    session::SessionStore,
};
use editac_core::{
    commands::text::TextOrigin,
    extensions::ai::{AI_VERSION, Error, Request, Response},
};
use editac_diff::{
    representation::{ImmutableRevision, RepresentationLimits, RevisionInput, RevisionScope},
    text::{PatchLimits, TextPatch},
};
use editac_markdown::reconcile::SourceMode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProposalStatus {
    Streaming,
    Review,
    Accepted,
    Canceled,
    Failed,
    Stale,
    RecoveryRequired,
    Disposed,
}
#[derive(Debug)]
pub enum AiAcceptanceError {
    State,
    InvalidProposal,
    Review(Box<ReviewError>),
}
/// Host-supplied generation is echoed by every async delivery, never reused after invalidation.
pub struct AiProposal {
    target: Option<ReviewTarget>,
    request: Request,
    generation: u64,
    writer: u32,
    deadline: u64,
    sequence: u32,
    text: String,
    status: ProposalStatus,
}
impl AiProposal {
    /// Call after host transport admission. Source/owners use existing review bindings.
    pub fn capture<S: SessionStore>(
        service: &EditService<S>,
        request: Request,
        generation: u64,
        source: &str,
        owners: &[String],
        now: u64,
        timeout_ms: u32,
    ) -> Result<Self, ServiceError> {
        if timeout_ms == 0
            || timeout_ms > 120_000
            || request.output_bytes == 0
            || request.output_bytes > 16_384
        {
            return Err(ServiceError::ResourceLimit);
        }
        Ok(Self {
            target: Some(service.capture_review(source, SourceMode::Literal, owners, now)?),
            request,
            generation,
            writer: service.session().document().writer_id(),
            deadline: now.saturating_add(u64::from(timeout_ms)),
            sequence: 0,
            text: String::new(),
            status: ProposalStatus::Streaming,
        })
    }
    pub fn status(&self) -> ProposalStatus {
        self.status
    }
    pub fn recovery_copy(&self) -> &str {
        &self.text
    }
    fn fail(&mut self, error: Error) -> Result<(), Error> {
        self.status = ProposalStatus::Failed;
        self.target = None;
        Err(error)
    }
    pub fn event(&mut self, generation: u64, event: Response, now: u64) -> Result<(), Error> {
        // Old operation callbacks cannot poison a newer operation or reopen terminal state.
        if generation != self.generation || self.status != ProposalStatus::Streaming {
            return Err(Error::Canceled);
        }
        if now >= self.deadline {
            return self.fail(Error::Timeout);
        }
        let (version, id, sequence) = match &event {
            Response::Delta {
                version,
                request_id,
                sequence,
                ..
            }
            | Response::Finish {
                version,
                request_id,
                sequence,
                ..
            }
            | Response::Error {
                version,
                request_id,
                sequence,
                ..
            } => (*version, request_id, *sequence),
        };
        if version != AI_VERSION || id != &self.request.request_id || sequence != self.sequence {
            return self.fail(Error::InvalidResponse);
        }
        self.sequence += 1;
        match event {
            Response::Delta { text, .. } => {
                if text.is_empty()
                    || self.text.len().saturating_add(text.len())
                        > self.request.output_bytes as usize
                {
                    return self.fail(Error::InvalidResponse);
                }
                self.text.push_str(&text);
            }
            Response::Finish { usage, .. } => {
                if self.text.is_empty()
                    || usage.is_some_and(|u| {
                        [u.input_tokens, u.output_tokens]
                            .into_iter()
                            .flatten()
                            .any(|n| n > 9_007_199_254_740_991)
                    })
                {
                    return self.fail(Error::InvalidResponse);
                }
                self.status = ProposalStatus::Review;
            }
            Response::Error { code, .. } => return self.fail(code),
        }
        Ok(())
    }
    pub fn cancel(&mut self) {
        if self.status != ProposalStatus::Disposed {
            self.status = ProposalStatus::Canceled;
            self.target = None;
        }
    }
    pub fn dispose(&mut self) {
        self.status = ProposalStatus::Disposed;
        self.target = None;
        self.text.clear();
    }
    /// Explicit acceptance; current permission, revision, epoch, source and history policy are
    /// rechecked by prepare_review/apply_review_as. Failure retains bounded copy-only output.
    pub fn accept<S: SessionStore>(
        &mut self,
        service: &mut EditService<S>,
        host: HostOperation,
        now: u64,
    ) -> Result<Option<LocalCommit>, AiAcceptanceError> {
        if self.status != ProposalStatus::Review
            || matches!(
                self.request.operation,
                editac_core::extensions::ai::Operation::Ask
            )
        {
            return Err(AiAcceptanceError::State);
        }
        let target = self.target.take().ok_or(AiAcceptanceError::State)?;
        self.status = ProposalStatus::Stale;
        if self.writer != service.session().document().writer_id() {
            return Err(AiAcceptanceError::State);
        }
        let revision = |source: &str| {
            ImmutableRevision::capture(
                RevisionScope {
                    document: "ai-review".into(),
                    epoch: "captured".into(),
                    schema: "v5".into(),
                    module_profile: "literal".into(),
                    observed_token: target.revision().to_bytes(),
                },
                RevisionInput::ExactSource(source.as_bytes()),
                RepresentationLimits::default(),
            )
        };
        let base = revision(target.source()).map_err(|_| AiAcceptanceError::InvalidProposal)?;
        let proposed = revision(&self.text).map_err(|_| AiAcceptanceError::InvalidProposal)?;
        let patch = TextPatch::between(&base, &proposed, PatchLimits::default())
            .map_err(|_| AiAcceptanceError::InvalidProposal)?;
        let origin =
            TextOrigin::new("ai:reviewed").map_err(|_| AiAcceptanceError::InvalidProposal)?;
        let prepared = service
            .prepare_review(
                &target,
                &patch,
                Acceptance::All,
                PatchLimits::default(),
                &origin,
                now,
            )
            .map_err(|error| AiAcceptanceError::Review(Box::new(error)))?;
        let result = match service.apply_review_as(prepared, host, now) {
            Ok(result) => result,
            Err(error) => {
                if service.session().state(now).readiness
                    == crate::session::Readiness::RecoveryRequired
                {
                    self.status = ProposalStatus::RecoveryRequired;
                }
                return Err(AiAcceptanceError::Review(Box::new(error)));
            }
        };
        self.status = ProposalStatus::Accepted;
        Ok(result)
    }
}
