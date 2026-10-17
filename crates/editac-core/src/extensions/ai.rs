//! Versioned, provider-independent AI host protocol. No engine mutation or I/O.
use serde::{Deserialize, Serialize};

pub const AI_VERSION: u32 = 1;
pub const AI_PROFILE: &str = "editac-ai-text-v1";
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    Ask,
    Fill,
    Continue,
    Rewrite,
    Completion,
}
pub const CAPABILITIES: [Operation; 5] = [
    Operation::Ask,
    Operation::Fill,
    Operation::Continue,
    Operation::Rewrite,
    Operation::Completion,
];
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Limits {
    pub requests: u32,
    pub instruction_bytes: u32,
    pub context_bytes: u32,
    pub output_bytes: u32,
    pub timeout_ms: u32,
}
impl Limits {
    pub fn validate(&self) -> Result<(), Error> {
        if self.requests == 0
            || self.requests > 10_000
            || self.instruction_bytes == 0
            || self.instruction_bytes > 16_384
            || self.context_bytes == 0
            || self.context_bytes > 32_768
            || self.output_bytes == 0
            || self.output_bytes > 16_384
            || self.timeout_ms == 0
            || self.timeout_ms > 120_000
        {
            return Err(Error::Limits);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Descriptor {
    pub version: u32,
    pub enabled: bool,
    pub capabilities: Vec<Operation>,
    pub limits: Option<Limits>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    Selection,
    Passage,
    Document,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub version: u32,
    pub request_id: String,
    pub operation: Operation,
    pub scope: Scope,
    pub instruction: String,
    pub context: String,
    pub format: String,
    pub output_bytes: u32,
}
/// Host authorization is supplied per dispatch, never inferred from text or credentials.
#[derive(Clone, Copy, Debug)]
pub struct Policy {
    pub allow_remote: bool,
    pub protected_document: bool,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Error {
    Unavailable,
    Version,
    Limits,
    Capability,
    Forbidden,
    Format,
    InvalidRequest,
    Quota,
    Canceled,
    Timeout,
    Transport,
    InvalidResponse,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Unavailable,
    Ready,
    Pending,
    Streaming,
    Complete,
    Canceled,
    Failed,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Response {
    Delta {
        version: u32,
        #[serde(rename = "requestId")]
        request_id: String,
        sequence: u32,
        text: String,
    },
    Finish {
        version: u32,
        #[serde(rename = "requestId")]
        request_id: String,
        sequence: u32,
        usage: Option<Usage>,
    },
    Error {
        version: u32,
        #[serde(rename = "requestId")]
        request_id: String,
        sequence: u32,
        code: Error,
    },
}
/// Per-editor monotonic reservation counter. Cancellation/failure never refunds admission.
#[derive(Default)]
pub struct Admission {
    used: u32,
}
impl Admission {
    pub fn used(&self) -> u32 {
        self.used
    }
    pub fn admit(
        &mut self,
        descriptor: Option<&Descriptor>,
        transport: bool,
        request: &Request,
        policy: Policy,
        canceled: bool,
    ) -> Result<(), Error> {
        let d = descriptor.filter(|d| d.enabled).ok_or(Error::Unavailable)?;
        if d.version != AI_VERSION || request.version != AI_VERSION {
            return Err(Error::Version);
        }
        let limits = d.limits.as_ref().ok_or(Error::Limits)?;
        limits.validate()?;
        if !transport {
            return Err(Error::Unavailable);
        }
        if d.capabilities.is_empty()
            || d.capabilities.len() > CAPABILITIES.len()
            || d.capabilities
                .iter()
                .enumerate()
                .any(|(i, c)| d.capabilities[..i].contains(c))
            || !d.capabilities.contains(&request.operation)
        {
            return Err(Error::Capability);
        }
        if !policy.allow_remote || policy.protected_document {
            return Err(Error::Forbidden);
        }
        if request.format != "plain-text" {
            return Err(Error::Format);
        }
        if request.request_id.is_empty()
            || request.request_id.len() > 128
            || !request
                .request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
            || request.instruction.is_empty()
            || request.instruction.len() > limits.instruction_bytes as usize
            || request.context.len() > limits.context_bytes as usize
            || request.output_bytes == 0
            || request.output_bytes > limits.output_bytes
        {
            return Err(Error::InvalidRequest);
        }
        if canceled {
            return Err(Error::Canceled);
        }
        if self.used >= limits.requests {
            return Err(Error::Quota);
        }
        self.used += 1;
        Ok(())
    }
}

/// Host-owned cancellation, shared with its backend worker. Cancel never refunds quota.
#[derive(Clone, Default)]
pub struct Cancellation(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::Release);
    }
    pub fn is_canceled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Acquire)
    }
}
/// Host adapter boundary. Implementations must propagate cancellation/deadline to
/// their backend and disable automatic retries. Events are ephemeral, never edits.
/// Async hosts may schedule this work externally; no executor or SDK is required.
pub trait Transport {
    fn send(
        &mut self,
        request: &Request,
        limits: &Limits,
        cancellation: &Cancellation,
        emit: &mut dyn FnMut(Response) -> Result<(), Error>,
    ) -> Result<(), Error>;
}
impl Admission {
    pub fn dispatch(
        &mut self,
        descriptor: Option<&Descriptor>,
        transport: Option<&mut dyn Transport>,
        request: &Request,
        policy: Policy,
        cancellation: &Cancellation,
        emit: &mut dyn FnMut(Response) -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.admit(
            descriptor,
            transport.is_some(),
            request,
            policy,
            cancellation.is_canceled(),
        )?;
        // Admission proved these options present. No rejected request reaches I/O.
        let limits = descriptor.unwrap().limits.as_ref().unwrap();
        let started = std::time::Instant::now();
        let mut sequence = 0u32;
        let mut total = 0usize;
        let mut terminal = false;
        let mut failure = None;
        let result = transport
            .unwrap()
            .send(request, limits, cancellation, &mut |event| {
                let checked = (|| {
                    if let Some(error) = failure {
                        return Err(error);
                    }
                    if cancellation.is_canceled() {
                        return Err(Error::Canceled);
                    }
                    if started.elapsed().as_millis() >= u128::from(limits.timeout_ms) {
                        return Err(Error::Timeout);
                    }
                    if terminal {
                        return Err(Error::InvalidResponse);
                    }
                    let (version, id, index) = match &event {
                        Response::Delta {
                            version,
                            request_id,
                            sequence,
                            text,
                        } => {
                            total = total
                                .checked_add(text.len())
                                .ok_or(Error::InvalidResponse)?;
                            if text.is_empty() || total > request.output_bytes as usize {
                                return Err(Error::InvalidResponse);
                            }
                            (*version, request_id, *sequence)
                        }
                        Response::Finish {
                            version,
                            request_id,
                            sequence,
                            usage,
                        } => {
                            if usage.as_ref().is_some_and(|u| {
                                [u.input_tokens, u.output_tokens]
                                    .into_iter()
                                    .flatten()
                                    .any(|n| n > 9_007_199_254_740_991)
                            }) {
                                return Err(Error::InvalidResponse);
                            }
                            terminal = true;
                            (*version, request_id, *sequence)
                        }
                        Response::Error {
                            version,
                            request_id,
                            sequence,
                            ..
                        } => {
                            terminal = true;
                            (*version, request_id, *sequence)
                        }
                    };
                    if version != AI_VERSION || id != &request.request_id || index != sequence {
                        return Err(Error::InvalidResponse);
                    }
                    sequence = sequence.checked_add(1).ok_or(Error::InvalidResponse)?;
                    emit(event)
                })();
                if let Err(error) = checked {
                    failure = Some(error);
                    cancellation.cancel();
                }
                checked
            });
        let outcome = if let Some(error) = failure {
            Err(error)
        } else if cancellation.is_canceled() {
            Err(Error::Canceled)
        } else if started.elapsed().as_millis() >= u128::from(limits.timeout_ms) {
            Err(Error::Timeout)
        } else {
            result.and(if terminal {
                Ok(())
            } else {
                Err(Error::InvalidResponse)
            })
        };
        if outcome.is_err() {
            cancellation.cancel();
        }
        outcome
    }
}
