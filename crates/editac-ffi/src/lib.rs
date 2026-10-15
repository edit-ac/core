//! Preparation ABI. One private serial executor per handle; owned output only.
//! The browser/native translators compile the exact same semantic bridge source.
#[path = "../../editac-wasm/src/bridge.rs"]
#[allow(dead_code)]
mod bridge;

mod session_commands;
pub use session_commands::*;
mod session;
pub use session::*;

use bridge::Bridge;
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum NativeError {
    #[error("invalid input: {message}")]
    InvalidInput { message: String },
    #[error("engine rejected: {message}")]
    EngineRejected { message: String },
    #[error("invalid or canceled handle: {message}")]
    InvalidHandle { message: String },
    #[error("resource limit: {message}")]
    ResourceLimit { message: String },
    #[error("engine disposed")]
    Disposed,
    #[error("executor unavailable")]
    ExecutorUnavailable,
}
type Result<T> = std::result::Result<T, NativeError>;
impl From<editac_core::interchange::Error> for NativeError {
    fn from(e: editac_core::interchange::Error) -> Self {
        let message = format!("{}: {}", e.operation, e.message);
        match e.code {
            "InvalidInput" => Self::InvalidInput { message },
            "InvalidHandle" => Self::InvalidHandle { message },
            "ResourceLimit" => Self::ResourceLimit { message },
            _ => Self::EngineRejected { message },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct AbiVersion {
    pub abi_version: u32,
    pub schema: String,
    pub profile: String,
    pub offset_units: String,
    pub update_encoding: u32,
    pub uniffi_version: String,
}
#[uniffi::export]
pub fn abi_version() -> AbiVersion {
    AbiVersion {
        abi_version: 1,
        schema: editac_core::document::STABLE_EDITOR_SCHEMA.into(),
        profile: editac_core::document::STABLE_EDITOR_PROFILE.into(),
        offset_units: "utf16".into(),
        update_encoding: 1,
        uniffi_version: "0.32.2".into(),
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct OwnedCheckpoint {
    pub metadata_json: String,
    pub bytes: Vec<u8>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct BatchResult {
    pub result_json: String,
    pub patch_json: String,
}
#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum AnchorBias {
    Left,
    Right,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct AnchorInput {
    pub node: String,
    /// UTF-16 code units, never UTF-8 bytes or Unicode scalar count.
    pub offset_utf16: u32,
    pub bias: AnchorBias,
}

type Task = Box<dyn FnOnce(&mut Bridge) + Send>;
struct Worker {
    sender: Option<mpsc::SyncSender<Task>>,
    join: Option<JoinHandle<()>>,
}
impl Worker {
    fn start(input: String, checkpoint: Option<Vec<u8>>) -> Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Task>(1);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let join = thread::Builder::new()
            .name("editac-native".into())
            .spawn(move || {
                // Construct and drop the document on this executor. No foreign callback.
                let bridge = match checkpoint {
                    Some(bytes) => Bridge::restore(&input, &bytes),
                    None => Bridge::create(&input),
                };
                match bridge {
                    Ok(mut bridge) => {
                        if ready_tx.send(Ok(())).is_ok() {
                            while let Ok(task) = receiver.recv() {
                                task(&mut bridge);
                            }
                        }
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(NativeError::from(error)));
                    }
                }
            })
            .map_err(|_| NativeError::ExecutorUnavailable)?;
        let mut worker = Self {
            sender: Some(sender),
            join: Some(join),
        };
        match ready_rx
            .recv()
            .map_err(|_| NativeError::ExecutorUnavailable)?
        {
            Ok(()) => Ok(worker),
            Err(error) => {
                worker.stop();
                Err(error)
            }
        }
    }
    fn call<R: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Bridge) -> Result<R> + Send + 'static,
    ) -> Result<R> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.sender
            .as_ref()
            .ok_or(NativeError::Disposed)?
            .send(Box::new(move |bridge| {
                let _ = sender.send(f(bridge));
            }))
            .map_err(|_| NativeError::ExecutorUnavailable)?;
        receiver
            .recv()
            .map_err(|_| NativeError::ExecutorUnavailable)?
    }
    fn stop(&mut self) {
        self.sender.take();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Foreign aliases share one handle. Rust operations serialize; disposal waits
/// for the in-flight operation and joins the executor. No lock-held callbacks.
#[derive(uniffi::Object)]
pub struct NativeEngine {
    worker: Mutex<Option<Worker>>,
}
impl NativeEngine {
    fn call<R: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Bridge) -> Result<R> + Send + 'static,
    ) -> Result<R> {
        let worker = self
            .worker
            .lock()
            .map_err(|_| NativeError::ExecutorUnavailable)?;
        worker.as_ref().ok_or(NativeError::Disposed)?.call(f)
    }
}
fn batch(bridge: &mut Bridge, token: &str) -> Result<BatchResult> {
    let result = bridge.commit(token)?;
    Ok(BatchResult {
        result_json: result.to_string(),
        patch_json: bridge.take_patch().to_string(),
    })
}
#[uniffi::export]
impl NativeEngine {
    #[uniffi::constructor]
    pub fn create(input_json: String) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            worker: Mutex::new(Some(Worker::start(input_json, None)?)),
        }))
    }
    #[uniffi::constructor]
    pub fn restore(input_json: String, bytes: Vec<u8>) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            worker: Mutex::new(Some(Worker::start(input_json, Some(bytes))?)),
        }))
    }
    pub fn dispose(&self) -> Result<()> {
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| NativeError::ExecutorUnavailable)?;
        // Idempotent; no further methods are allowed after this transition.
        if let Some(mut worker) = worker.take() {
            worker.stop();
        }
        Ok(())
    }
    pub fn read(&self) -> Result<String> {
        self.call(|b| {
            let mut snapshot = b.read()?;
            // Native hosts receive presentation data, not retained engine storage.
            snapshot
                .as_object_mut()
                .expect("bridge snapshot")
                .remove("retainedStructure");
            Ok(snapshot.to_string())
        })
    }
    pub fn checkpoint(&self) -> Result<OwnedCheckpoint> {
        self.call(|b| {
            Ok(OwnedCheckpoint {
                metadata_json: b.checkpoint_metadata().to_string(),
                bytes: b.checkpoint_bytes(),
            })
        })
    }
    /// One prepared atomic command batch, one boundary call, one detached patch.
    pub fn execute_batch(&self, commands_json: String) -> Result<BatchResult> {
        self.call(move |b| {
            #[cfg(feature = "fitness-trace")]
            let started = std::time::Instant::now();
            let plan = b.prepare(&commands_json)?;
            #[cfg(feature = "fitness-trace")]
            {
                let prepared = started.elapsed().as_secs_f64() * 1000.0;
                let mut result = b.commit(plan["token"].as_str().expect("bridge token"))?;
                let committed = started.elapsed().as_secs_f64() * 1000.0;
                let patch = b.take_patch();
                let patched = started.elapsed().as_secs_f64() * 1000.0;
                let patch_json = patch.to_string();
                let serialized_patch = started.elapsed().as_secs_f64() * 1000.0;
                // Serialize the production result before adding diagnostic metadata.
                // Swift's enclosing span includes this instrumentation overhead.
                let _production_result = result.to_string();
                let serialized_result = started.elapsed().as_secs_f64() * 1000.0;
                result["fitnessTrace"] = serde_json::json!({"version":1,
                    "prepareMs":prepared,"commitMs":committed-prepared,
                    "patchBuildMs":patched-committed,"patchJsonMs":serialized_patch-patched,
                    "resultJsonMs":serialized_result-serialized_patch});
                return Ok(BatchResult {
                    result_json: result.to_string(),
                    patch_json,
                });
            }
            #[cfg(not(feature = "fitness-trace"))]
            batch(b, plan["token"].as_str().expect("bridge token"))
        })
    }
    pub fn prepare_batch(&self, commands_json: String) -> Result<String> {
        self.call(move |b| {
            Ok(b.prepare(&commands_json)?["token"]
                .as_str()
                .expect("bridge token")
                .into())
        })
    }
    pub fn commit_batch(&self, token: String) -> Result<BatchResult> {
        self.call(move |b| batch(b, &token))
    }
    /// Cancellation releases an uncommitted plan; it cannot interrupt a commit.
    pub fn cancel_batch(&self, token: String) -> Result<()> {
        self.call(move |b| {
            b.release_plan(&token);
            Ok(())
        })
    }
    pub fn capture_anchor(&self, input: AnchorInput) -> Result<String> {
        self.call(move |b| {
            let bias = match input.bias {
                AnchorBias::Left => "left",
                AnchorBias::Right => "right",
            };
            let request =
                serde_json::json!({"node":input.node,"offset":input.offset_utf16,"bias":bias})
                    .to_string();
            Ok(b.capture(&request)?["token"]
                .as_str()
                .expect("bridge token")
                .into())
        })
    }
    pub fn resolve_anchor(&self, token: String) -> Result<String> {
        self.call(move |b| Ok(b.resolve(&token)?.to_string()))
    }
    pub fn export_anchor(&self, token: String) -> Result<String> {
        self.call(move |b| Ok(b.export_anchor(&token)?.to_string()))
    }
    pub fn import_anchor(&self, portable_json: String) -> Result<String> {
        self.call(move |b| {
            Ok(b.import_anchor(&portable_json)?["token"]
                .as_str()
                .expect("bridge token")
                .into())
        })
    }
    pub fn release_anchor(&self, token: String) -> Result<()> {
        self.call(move |b| {
            b.release_anchor(&token);
            Ok(())
        })
    }
    pub fn state_vector(&self) -> Result<Vec<u8>> {
        self.call(|b| Ok(b.state_vector()))
    }
    pub fn encode_update(&self, vector: Vec<u8>) -> Result<Vec<u8>> {
        self.call(move |b| Ok(b.update(&vector)?))
    }
    pub fn apply_update(&self, identity_json: String, bytes: Vec<u8>) -> Result<BatchResult> {
        self.call(move |b| {
            Ok(BatchResult {
                result_json: b.apply(&identity_json, &bytes)?.to_string(),
                patch_json: b.take_patch().to_string(),
            })
        })
    }
    pub fn take_patch(&self) -> Result<String> {
        self.call(|b| Ok(b.take_patch().to_string()))
    }
    pub fn history(&self, request_json: String) -> Result<BatchResult> {
        self.call(move |b| {
            Ok(BatchResult {
                result_json: b.history(&request_json)?.to_string(),
                patch_json: b.take_patch().to_string(),
            })
        })
    }
}

#[cfg(test)]
mod abi_wire_tests {
    use super::*;
    use uniffi::{Lift, Lower};
    #[test]
    fn generated_record_lower_lift_preserves_utf16_u32_without_narrowing() {
        let input = AnchorInput {
            node: "😀".into(),
            offset_utf16: u32::MAX,
            bias: AnchorBias::Right,
        };
        let buffer = <AnchorInput as Lower<UniFfiTag>>::lower(input);
        let output = <AnchorInput as Lift<UniFfiTag>>::try_lift(buffer).unwrap();
        assert_eq!(output.node, "😀");
        assert_eq!(output.offset_utf16, u32::MAX);
        assert!(matches!(output.bias, AnchorBias::Right));
    }
    #[test]
    fn generated_owned_byte_record_lower_lift_preserves_all_byte_values() {
        let input = OwnedCheckpoint {
            metadata_json: "owned 😀".into(),
            bytes: (0..=255).collect(),
        };
        let buffer = <OwnedCheckpoint as Lower<UniFfiTag>>::lower(input);
        let output = <OwnedCheckpoint as Lift<UniFfiTag>>::try_lift(buffer).unwrap();
        assert_eq!(output.metadata_json, "owned 😀");
        assert_eq!(output.bytes, (0..=255).collect::<Vec<u8>>());
    }
}
