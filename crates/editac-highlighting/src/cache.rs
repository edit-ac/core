//! Session-owned block-incremental projection. Changed blocks are fully parsed;
//! unaffected blocks reuse exact snapshots. No document, CRDT or history handle is
//! accepted. Drop/replace this port when its editing session is replaced.
use crate::{BACKEND_ID, Backend, MAX_SOURCE_BYTES, MAX_SPANS, Status, TokenSpan};
use serde::Serialize;
use std::{
    collections::{BTreeMap, VecDeque},
    mem::size_of,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);
const MAX_ID_BYTES: usize = 256;

/// Versions are host profile identities. Grammar must name the pinned backend;
/// unknown grammar versions produce plain source, never mislabeled tokens.
/// Syntect has no external query asset; query/theme identify consumer projections.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct BlockInput {
    pub block: String,
    pub revision: u64,
    pub language: String,
    pub grammar: String,
    pub query: String,
    pub theme: String,
    pub enabled: bool,
    pub source: String,
}
impl BlockInput {
    fn validate(&self) -> Result<(), Rejection> {
        if [
            &self.block,
            &self.language,
            &self.grammar,
            &self.query,
            &self.theme,
        ]
        .iter()
        .any(|v| v.is_empty() || v.len() > MAX_ID_BYTES)
            || self.source.len() > MAX_SOURCE_BYTES
        {
            return Err(Rejection::InvalidInput);
        }
        Ok(())
    }
    fn bytes(&self) -> usize {
        [
            &self.block,
            &self.language,
            &self.grammar,
            &self.query,
            &self.theme,
            &self.source,
        ]
        .iter()
        .map(|s| s.capacity())
        .sum()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub entries: usize,
    pub bytes: usize,
    pub spans: usize,
    pub pending: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            entries: 64,
            bytes: 2 * 1024 * 1024,
            spans: 32_768,
            pending: 16,
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Counters {
    pub hits: u64,
    pub misses: u64,
    pub recomputed_blocks: u64,
    /// Bytes supplied to a non-cached backend call (including canceled work).
    pub supplied_bytes: u64,
    pub evictions: u64,
    pub rejected: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejection {
    InvalidInput,
    InvalidLimits,
    Busy,
    Stale,
    ForeignSession,
    Cancelled,
    Disposed,
    InvalidSpans,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Projection {
    pub status: Status,
    pub spans: Vec<TokenSpan>,
}
impl Projection {
    fn bytes(&self) -> usize {
        self.spans.capacity() * size_of::<TokenSpan>()
            + self
                .spans
                .iter()
                .map(|s| {
                    s.scopes.capacity() * size_of::<String>()
                        + s.scopes.iter().map(String::capacity).sum::<usize>()
                })
                .sum::<usize>()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CacheHandle {
    owner: u64,
    generation: u64,
}
#[derive(Debug, Serialize)]
pub struct Published {
    pub input: BlockInput,
    pub projection: Projection,
    /// None means the result was valid but too large for this cache's budget.
    pub cache: Option<CacheHandle>,
}
struct Pending {
    generation: u64,
    cancel: Arc<AtomicBool>,
}
struct Entry {
    input: BlockInput,
    projection: Projection,
    handle: CacheHandle,
    bytes: usize,
}

/// A move-only immutable job. Cancellation can be shared with an owned worker.
/// Outstanding job/completion storage belongs to that worker; port-owned pending
/// state is capped separately. Hosts must bound their queue and release old jobs.
pub struct Job {
    owner: u64,
    generation: u64,
    input: BlockInput,
    cancel: Arc<AtomicBool>,
    cached: Option<Projection>,
}
impl Job {
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }
    pub fn compute(self, backend: &Backend) -> Completion {
        let mut recomputed = false;
        let projection = if self.cancel.load(Ordering::Acquire) {
            Projection {
                status: Status::Cancelled,
                spans: vec![],
            }
        } else if let Some(cached) = self.cached {
            cached
        } else if self.input.grammar != BACKEND_ID {
            Projection {
                status: Status::UnsupportedGrammar,
                spans: vec![],
            }
        } else {
            recomputed = true;
            let output = backend.highlight_cancellable(
                &self.input.language,
                &self.input.source,
                self.input.enabled,
                || self.cancel.load(Ordering::Acquire),
            );
            Projection {
                status: output.status,
                spans: output.spans,
            }
        };
        Completion {
            owner: self.owner,
            generation: self.generation,
            input: self.input,
            cancel: self.cancel,
            projection,
            recomputed,
        }
    }
}
pub struct Completion {
    owner: u64,
    generation: u64,
    input: BlockInput,
    cancel: Arc<AtomicBool>,
    projection: Projection,
    recomputed: bool,
}

pub struct HighlightCache {
    owner: u64,
    generation: u64,
    limits: Limits,
    disposed: bool,
    entries: VecDeque<Entry>,
    pending: BTreeMap<String, Pending>,
    counters: Counters,
}
impl HighlightCache {
    pub fn new(limits: Limits) -> Result<Self, Rejection> {
        let hard = Limits::default();
        if limits.entries > hard.entries
            || limits.bytes > hard.bytes
            || limits.spans > hard.spans
            || limits.pending == 0
            || limits.pending > hard.pending
        {
            return Err(Rejection::InvalidLimits);
        }
        let owner = NEXT_OWNER
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .expect("highlight session identities exhausted");
        Ok(Self {
            owner,
            generation: 0,
            limits,
            disposed: false,
            entries: VecDeque::new(),
            pending: BTreeMap::new(),
            counters: Counters::default(),
        })
    }
    pub fn begin(&mut self, input: BlockInput) -> Result<Job, Rejection> {
        self.begin_with_prior(input, None)
    }
    pub fn begin_with_prior(
        &mut self,
        input: BlockInput,
        prior: Option<CacheHandle>,
    ) -> Result<Job, Rejection> {
        if self.disposed {
            return Err(Rejection::Disposed);
        }
        if prior.is_some_and(|h| h.owner != self.owner) {
            return Err(Rejection::ForeignSession);
        }
        input.validate()?;
        if !self.pending.contains_key(&input.block) && self.pending.len() == self.limits.pending {
            return Err(Rejection::Busy);
        }
        self.cancel_block(&input.block);
        self.generation = self
            .generation
            .checked_add(1)
            .expect("highlight generations exhausted");
        let cancel = Arc::new(AtomicBool::new(false));
        self.pending.insert(
            input.block.clone(),
            Pending {
                generation: self.generation,
                cancel: cancel.clone(),
            },
        );
        // Exact source equality also defends against a host reusing a revision for different bytes.
        let cached = self.entries.iter().position(|e| e.input == input).map(|i| {
            let entry = self.entries.remove(i).expect("located entry");
            let projection = entry.projection.clone();
            self.entries.push_back(entry);
            projection
        });
        if cached.is_some() {
            self.counters.hits += 1;
        } else {
            self.counters.misses += 1;
        }
        Ok(Job {
            owner: self.owner,
            generation: self.generation,
            input,
            cancel,
            cached,
        })
    }
    /// The only publication boundary. Consumes the completion exactly once and
    /// rejects superseded, canceled, replaced-session and disposed requests.
    pub fn publish(&mut self, done: Completion) -> Result<Published, Rejection> {
        if done.owner != self.owner {
            return Err(Rejection::ForeignSession);
        }
        if done.recomputed {
            self.counters.recomputed_blocks += 1;
            self.counters.supplied_bytes += done.input.source.len() as u64;
        }
        let rejection = if self.disposed {
            Some(Rejection::Disposed)
        } else if !self
            .pending
            .get(&done.input.block)
            .is_some_and(|p| p.generation == done.generation)
        {
            Some(Rejection::Stale)
        } else if done.cancel.load(Ordering::Acquire) || done.projection.status == Status::Cancelled
        {
            Some(Rejection::Cancelled)
        } else {
            None
        };
        if let Some(reason) = rejection {
            self.counters.rejected += 1;
            if reason == Rejection::Cancelled {
                self.pending.remove(&done.input.block);
            }
            return Err(reason);
        }
        self.pending.remove(&done.input.block);
        validate_projection(&done.input.source, &done.projection)?;
        let handle = CacheHandle {
            owner: self.owner,
            generation: done.generation,
        };
        // Retain one revision per block. Undo is new work unless its exact current
        // input remains cached; unrelated blocks keep their own entries.
        self.entries.retain(|e| e.input.block != done.input.block);
        let entry = Entry {
            input: done.input.clone(),
            projection: done.projection.clone(),
            handle,
            bytes: 0,
        };
        let bytes = size_of::<Entry>() + entry.input.bytes() + entry.projection.bytes();
        let cacheable = self.limits.entries > 0
            && bytes <= self.limits.bytes
            && entry.projection.spans.len() <= self.limits.spans;
        if cacheable {
            while self.entries.len() >= self.limits.entries
                || self.retained_bytes() + bytes > self.limits.bytes
                || self.retained_spans() + entry.projection.spans.len() > self.limits.spans
            {
                self.entries.pop_front();
                self.counters.evictions += 1;
            }
            self.entries.push_back(Entry { bytes, ..entry });
        }
        Ok(Published {
            input: done.input,
            projection: done.projection,
            cache: cacheable.then_some(handle),
        })
    }
    pub fn contains(&self, handle: CacheHandle) -> bool {
        self.entries.iter().any(|e| e.handle == handle)
    }
    pub fn counters(&self) -> Counters {
        self.counters
    }
    /// Payload capacities plus per-entry records. Container allocator overhead is
    /// separately bounded by fixed entry/pending limits, not reported as RSS.
    pub fn retained_bytes(&self) -> usize {
        self.entries.iter().map(|e| e.bytes).sum()
    }
    pub fn retained_spans(&self) -> usize {
        self.entries.iter().map(|e| e.projection.spans.len()).sum()
    }
    pub fn retained_entries(&self) -> usize {
        self.entries.len()
    }
    pub fn pending(&self) -> usize {
        self.pending.len()
    }
    pub fn cancel_block(&mut self, block: &str) {
        if let Some(p) = self.pending.remove(block) {
            p.cancel.store(true, Ordering::Release);
        }
    }
    pub fn remove_block(&mut self, block: &str) {
        self.cancel_block(block);
        self.entries.retain(|e| e.input.block != block);
    }
    pub fn dispose(&mut self) {
        for p in self.pending.values() {
            p.cancel.store(true, Ordering::Release);
        }
        self.pending.clear();
        self.entries.clear();
        self.disposed = true;
    }
}
impl Drop for HighlightCache {
    fn drop(&mut self) {
        self.dispose();
    }
}

/// Convert only scalar boundaries: public offsets never split a surrogate pair.
pub fn utf8_to_utf16(source: &str, byte: usize) -> Result<u32, Rejection> {
    if source.len() > MAX_SOURCE_BYTES || !source.is_char_boundary(byte) {
        return Err(Rejection::InvalidSpans);
    }
    Ok(source[..byte].encode_utf16().count() as u32)
}
pub fn utf16_to_utf8(source: &str, offset: u32) -> Result<usize, Rejection> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(Rejection::InvalidSpans);
    }
    let mut units = 0;
    for (byte, ch) in source.char_indices() {
        if units == offset {
            return Ok(byte);
        }
        units += ch.len_utf16() as u32;
        if units > offset {
            return Err(Rejection::InvalidSpans);
        }
    }
    if units == offset {
        Ok(source.len())
    } else {
        Err(Rejection::InvalidSpans)
    }
}
/// Validate ordered, gap-free, nonempty runs against a single UTF-16 boundary map.
/// Plain-source fallbacks must carry no partial tokens.
pub fn validate_projection(source: &str, projection: &Projection) -> Result<(), Rejection> {
    if source.len() > MAX_SOURCE_BYTES || projection.spans.len() > MAX_SPANS {
        return Err(Rejection::InvalidSpans);
    }
    if projection.status != Status::Highlighted {
        return if projection.spans.is_empty() {
            Ok(())
        } else {
            Err(Rejection::InvalidSpans)
        };
    }
    let mut boundaries = vec![true];
    for ch in source.chars() {
        if ch.len_utf16() == 2 {
            boundaries.push(false);
        }
        boundaries.push(true);
    }
    let mut previous = 0;
    for span in &projection.spans {
        if span.start != previous
            || span.end <= span.start
            || boundaries.get(span.start as usize) != Some(&true)
            || boundaries.get(span.end as usize) != Some(&true)
            || span.scopes.len() > 256
            || span.scopes.iter().any(|s| s.len() > 256)
        {
            return Err(Rejection::InvalidSpans);
        }
        previous = span.end;
    }
    if previous as usize != boundaries.len() - 1 {
        return Err(Rejection::InvalidSpans);
    }
    Ok(())
}
