//! Bounded optional derived-work lifecycle; never owns semantic updates or store receipts.
//! Hosts own scheduling/provider cancellation. A cancelled running provider retains its slot
//! until `complete` confirms termination. Every admitted ticket receives one terminal outcome.
use std::collections::VecDeque;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceScope {
    pub document: String,
    pub session: String,
    pub revision: String,
    pub permission: String,
    pub authorized: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceOutcome {
    Ready,
    Invalid,
    ResourceLimit,
    Saturated,
    Cancelled,
    Disposed,
    Deadline,
    StaleRevision,
    ReplacedSession,
    PermissionLoss,
    ProviderFailed,
}
impl ServiceScope {
    pub fn valid(&self) -> bool {
        [
            &self.document,
            &self.session,
            &self.revision,
            &self.permission,
        ]
        .iter()
        .all(|s| {
            !s.is_empty() && s.encode_utf16().count() <= 512 && !s.chars().any(|c| c.is_control())
        })
    }
    pub fn failure(&self, current: &Self) -> Option<ServiceOutcome> {
        if !self.valid() || !current.valid() {
            Some(ServiceOutcome::Invalid)
        } else if self.document != current.document || self.session != current.session {
            Some(ServiceOutcome::ReplacedSession)
        } else if !self.authorized || !current.authorized || self.permission != current.permission {
            Some(ServiceOutcome::PermissionLoss)
        } else if self.revision != current.revision {
            Some(ServiceOutcome::StaleRevision)
        } else {
            None
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct ServiceLimits {
    pub concurrency: usize,
    pub queue: usize,
    pub bytes: usize,
    pub items: usize,
    pub deadline_ms: u64,
}
#[derive(Clone, Debug)]
pub struct ServiceRequest {
    pub scope: ServiceScope,
    pub bytes: usize,
    pub items: usize,
    /// Host monotonic milliseconds, not a wall-clock timestamp.
    pub deadline: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ServiceTicket(u64);
#[derive(Clone, Debug)]
struct Job {
    ticket: ServiceTicket,
    request: ServiceRequest,
    settled: bool,
}
pub struct ServiceLifecycle {
    limits: ServiceLimits,
    active: Vec<Job>,
    queued: VecDeque<Job>,
    sequence: u64,
    disposed: bool,
}
impl ServiceLifecycle {
    pub fn new(limits: ServiceLimits) -> Result<Self, ServiceOutcome> {
        if limits.concurrency == 0
            || limits.concurrency > 64
            || limits.queue > 4096
            || limits.bytes == 0
            || limits.items == 0
            || limits.deadline_ms == 0
            || limits.deadline_ms > 0x7fffffff
        {
            return Err(ServiceOutcome::Invalid);
        }
        Ok(Self {
            limits,
            active: Vec::new(),
            queued: VecDeque::new(),
            sequence: 0,
            disposed: false,
        })
    }
    pub fn state(&self) -> (usize, usize, bool) {
        (self.active.len(), self.queued.len(), self.disposed)
    }
    fn failure(
        &self,
        request: &ServiceRequest,
        current: &ServiceScope,
        now: u64,
    ) -> Option<ServiceOutcome> {
        if now >= request.deadline {
            Some(ServiceOutcome::Deadline)
        } else if self.disposed {
            Some(ServiceOutcome::Disposed)
        } else {
            request.scope.failure(current)
        }
    }
    pub fn admit(
        &mut self,
        request: ServiceRequest,
        current: &ServiceScope,
        now: u64,
    ) -> Result<ServiceTicket, ServiceOutcome> {
        if !request.scope.valid() || request.deadline.saturating_sub(now) > self.limits.deadline_ms
        {
            return Err(ServiceOutcome::Invalid);
        }
        if let Some(failure) = self.failure(&request, current, now) {
            return Err(failure);
        }
        if request.bytes > self.limits.bytes || request.items > self.limits.items {
            return Err(ServiceOutcome::ResourceLimit);
        }
        // Before a scheduler starts admitted work, reserve free concurrency slots too.
        if self.active.len() + self.queued.len() >= self.limits.concurrency + self.limits.queue {
            return Err(ServiceOutcome::Saturated);
        }
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or(ServiceOutcome::ResourceLimit)?;
        let ticket = ServiceTicket(self.sequence);
        self.queued.push_back(Job {
            ticket,
            request,
            settled: false,
        });
        Ok(ticket)
    }
    /// Revalidate before calling the provider. Expired/stale work returns a terminal event.
    pub fn start_next(
        &mut self,
        current: &ServiceScope,
        now: u64,
    ) -> Option<Result<(ServiceTicket, ServiceRequest), (ServiceTicket, ServiceOutcome)>> {
        if self.disposed || self.active.len() >= self.limits.concurrency {
            return None;
        }
        let job = self.queued.pop_front()?;
        if let Some(failure) = self.failure(&job.request, current, now) {
            return Some(Err((job.ticket, failure)));
        }
        let started = (job.ticket, job.request.clone());
        self.active.push(job);
        Some(Ok(started))
    }
    /// Only provider termination releases active capacity. A prior terminal event cannot
    /// become Ready again; caller-owned terminal results and durable receipts are untouched.
    pub fn complete(
        &mut self,
        ticket: ServiceTicket,
        current: &ServiceScope,
        now: u64,
        provider_ok: bool,
    ) -> Option<ServiceOutcome> {
        let index = self.active.iter().position(|j| j.ticket == ticket)?;
        let job = self.active.remove(index);
        if job.settled {
            return None;
        }
        Some(
            self.failure(&job.request, current, now)
                .unwrap_or(if provider_ok {
                    ServiceOutcome::Ready
                } else {
                    ServiceOutcome::ProviderFailed
                }),
        )
    }
    pub fn cancel(&mut self, ticket: ServiceTicket) -> Option<ServiceOutcome> {
        if let Some(index) = self.queued.iter().position(|j| j.ticket == ticket) {
            self.queued.remove(index);
            return Some(ServiceOutcome::Cancelled);
        }
        let job = self.active.iter_mut().find(|j| j.ticket == ticket)?;
        if job.settled {
            return None;
        }
        job.settled = true;
        Some(ServiceOutcome::Cancelled)
    }
    /// Emit events for every invalidated request; the host aborts corresponding providers.
    pub fn revalidate(
        &mut self,
        current: &ServiceScope,
        now: u64,
    ) -> Vec<(ServiceTicket, ServiceOutcome)> {
        let mut events = Vec::new();
        let disposed = self.disposed;
        let failure = |j: &Job| {
            if now >= j.request.deadline {
                Some(ServiceOutcome::Deadline)
            } else if disposed {
                Some(ServiceOutcome::Disposed)
            } else {
                j.request.scope.failure(current)
            }
        };
        for job in &mut self.active {
            if !job.settled {
                if let Some(reason) = failure(job) {
                    job.settled = true;
                    events.push((job.ticket, reason));
                }
            }
        }
        self.queued.retain(|job| {
            if let Some(reason) = failure(job) {
                events.push((job.ticket, reason));
                false
            } else {
                true
            }
        });
        events
    }
    pub fn dispose(&mut self) -> Vec<(ServiceTicket, ServiceOutcome)> {
        self.disposed = true;
        let mut events = Vec::new();
        for job in &mut self.active {
            if !job.settled {
                job.settled = true;
                events.push((job.ticket, ServiceOutcome::Disposed));
            }
        }
        events.extend(
            self.queued
                .drain(..)
                .map(|j| (j.ticket, ServiceOutcome::Disposed)),
        );
        events
    }
}
