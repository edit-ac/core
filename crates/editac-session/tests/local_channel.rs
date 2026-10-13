mod support;
use editac_core::{
    Utf16Offset, anchors::Bias, commands::text::TextCommand, document::DocumentIdentity,
};
use editac_session::{
    local_channel::*,
    ports::{memory::*, *},
    session::*,
};
use std::sync::Arc;
use support::{origin, owner, text};
fn identity() -> DocumentIdentity {
    support::checkpoint().identity.clone()
}
fn insert<S: SessionStore>(session: &mut Session<S>, value: &str) {
    let at = session
        .document()
        .anchor(&owner(session.document()), Utf16Offset(0), Bias::Right)
        .unwrap();
    session
        .edit_text(
            &TextCommand::Insert {
                at,
                text: value.into(),
            },
            &origin(),
            0,
        )
        .unwrap();
}
fn pair() -> (
    Arc<MemoryStore>,
    Session<Arc<MemoryStore>>,
    Session<Arc<MemoryStore>>,
) {
    let store = Arc::new(MemoryStore::new(identity(), StoreLimits::default()).unwrap());
    store
        .publish(
            0,
            CheckpointRecord::new(support::checkpoint().clone(), vec![]).unwrap(),
        )
        .unwrap();
    let a = Session::open(store.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    let b = Session::open(store.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    (store, a, b)
}
#[test]
fn local_channel_offline_delivery_is_explicit_and_echo_free() {
    let (store, mut a, mut b) = pair();
    let (mut ca, mut cb) = MemoryChannel::pair(2).unwrap();
    assert_ne!(a.document().writer_id(), b.document().writer_id());
    insert(&mut a, "A");
    assert_eq!(text(b.document()), "");
    assert_eq!(b.receive_local(&mut cb).unwrap(), 0); // Shared storage is not delivery.
    a.notify_local(&mut ca).unwrap();
    assert_eq!(b.receive_local(&mut cb).unwrap(), 1);
    assert_eq!(text(b.document()), "A");
    assert_eq!(a.receive_local(&mut ca).unwrap(), 0);
    a.notify_local(&mut ca).unwrap();
    assert_eq!(b.receive_local(&mut cb).unwrap(), 0);
    assert_eq!(store.pending(&identity()).unwrap().len(), 1);
    assert!(b.undo(0).unwrap().is_none()); // Remote replay is not local typing undo.
}
#[test]
fn local_channel_concurrent_offline_edits_restart_and_checkpoint_cas() {
    let (store, mut a, mut b) = pair();
    let (mut ca, mut cb) = MemoryChannel::pair(2).unwrap();
    insert(&mut a, "A");
    insert(&mut b, "B");
    a.notify_local(&mut ca).unwrap();
    b.notify_local(&mut cb).unwrap();
    a.receive_local(&mut ca).unwrap();
    b.receive_local(&mut cb).unwrap();
    assert_eq!(text(a.document()), text(b.document()));
    assert_eq!(text(a.document()).len(), 2);
    let entries = store.recover(&identity()).unwrap().journal;
    let coverage = entries.iter().map(|entry| entry.id().clone()).collect();
    let checkpoint = CheckpointRecord::new(a.document().checkpoint(), coverage).unwrap();
    let generation = store.generation(&identity()).unwrap();
    store.publish(generation, checkpoint.clone()).unwrap();
    assert_eq!(
        store.publish(generation, checkpoint),
        Err(PortError::Conflict)
    );
    let mut restarted = Session::open(store.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    assert_ne!(restarted.document().writer_id(), b.document().writer_id());
    assert_eq!(text(restarted.document()), text(a.document()));
    insert(&mut a, "C"); // missed hint while detached is recovered by explicit reconnect.
    restarted.catch_up_local().unwrap();
    assert_eq!(text(restarted.document()), text(a.document()));
    assert_eq!(store.pending(&identity()).unwrap().len(), 3);
}
#[test]
fn local_channel_backpressure_preserves_committed_work() {
    let (store, mut a, mut b) = pair();
    let (mut ca, mut cb) = MemoryChannel::pair(1).unwrap();
    insert(&mut a, "A");
    a.notify_local(&mut ca).unwrap();
    insert(&mut a, "B");
    assert_eq!(
        a.notify_local(&mut ca),
        Err(SessionError::Store(PortError::Backpressure))
    );
    b.receive_local(&mut cb).unwrap();
    assert_eq!(text(a.document()), text(b.document()));
    assert_eq!(store.pending(&identity()).unwrap().len(), 2);
    assert!(MemoryChannel::pair(0).is_err());
    assert!(MemoryChannel::pair(65).is_err());
}
#[test]
fn local_channel_hosted_reconnect_converges_without_receipts() {
    let (local, mut a, mut b) = pair();
    let remote = Arc::new(MemoryStore::new(identity(), StoreLimits::default()).unwrap());
    remote
        .publish(
            0,
            CheckpointRecord::new(a.document().checkpoint(), vec![]).unwrap(),
        )
        .unwrap();
    let mut peer = Session::open(remote.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    insert(&mut a, "A");
    insert(&mut b, "B");
    insert(&mut peer, "H");
    let outgoing = local.recover(&identity()).unwrap().journal;
    let incoming = remote.recover(&identity()).unwrap().journal;
    for entry in outgoing {
        peer.receive_peer(entry).unwrap();
    }
    for entry in incoming {
        a.receive_peer(entry).unwrap();
    }
    b.catch_up_local().unwrap();
    a.catch_up_local().unwrap();
    assert_eq!(text(a.document()), text(peer.document()));
    assert_eq!(text(b.document()), text(peer.document()));
    assert_eq!(text(a.document()).len(), 3);
    assert_eq!(a.state(0).pending_upload, 3);
    assert_ne!(a.state(0).remote, RemoteState::RemotelyCommitted);
}
#[test]
fn local_channel_incoming_failure_and_wrong_scope_never_mutate() {
    let store = Arc::new(FaultInjectedStore::new(identity(), StoreLimits::default()).unwrap());
    store
        .publish(
            0,
            CheckpointRecord::new(support::checkpoint().clone(), vec![]).unwrap(),
        )
        .unwrap();
    let mut a = Session::open(store.clone(), &identity(), CachedPermission::LOCAL).unwrap();
    let (other, mut b, _) = pair();
    insert(&mut b, "B");
    let entry = other.recover(&identity()).unwrap().journal[0].clone();
    store
        .inject(InjectedFault {
            boundary: FaultBoundary::BeforeCommit,
            error: PortError::Quota,
        })
        .unwrap();
    assert!(a.receive_peer(entry.clone()).is_err());
    assert_eq!(text(a.document()), "");
    assert_eq!(a.state(0).readiness, Readiness::RecoveryRequired);
    a.recover().unwrap();
    a.receive_peer(entry).unwrap();
    assert_eq!(text(a.document()), "B");
    let invalid = JournalEntry::new(identity(), 99, 1, "bad".into(), vec![255]).unwrap();
    assert!(a.receive_peer(invalid).is_err());
    assert_eq!(text(a.document()), "B");
    let mut wrong = identity();
    wrong.epoch = "34567890-3456-4456-8456-34567890abcd".into();
    let invalid = JournalEntry::new(wrong, 99, 1, "wrong".into(), vec![0]).unwrap();
    assert!(a.receive_peer(invalid).is_err());
    assert_eq!(text(a.document()), "B");
}

#[test]
fn local_channel_committed_ack_loss_and_corrupt_store_freeze_admission() {
    for boundary in [
        FaultBoundary::BeforeWrite,
        FaultBoundary::BeforeCommit,
        FaultBoundary::AfterCommit,
    ] {
        let store = Arc::new(FaultInjectedStore::new(identity(), StoreLimits::default()).unwrap());
        store
            .publish(
                0,
                CheckpointRecord::new(support::checkpoint().clone(), vec![]).unwrap(),
            )
            .unwrap();
        let mut receiver =
            Session::open(store.clone(), &identity(), CachedPermission::LOCAL).unwrap();
        let (source, mut sender, _) = pair();
        insert(&mut sender, "R");
        let entry = source.recover(&identity()).unwrap().journal[0].clone();
        store
            .inject(InjectedFault {
                boundary,
                error: PortError::CommitUnknown,
            })
            .unwrap();
        assert!(receiver.receive_peer(entry.clone()).is_err());
        assert_eq!(text(receiver.document()), "");
        assert_eq!(receiver.state(0).readiness, Readiness::RecoveryRequired);
        receiver.recover().unwrap();
        receiver.receive_peer(entry).unwrap();
        assert_eq!(text(receiver.document()), "R");
        assert_eq!(store.pending(&identity()).unwrap().len(), 1);
        store.corrupt_journal().unwrap();
        assert!(receiver.catch_up_local().is_err());
        assert_eq!(receiver.state(0).readiness, Readiness::RecoveryRequired);
        assert_eq!(text(receiver.document()), "R");
        assert_eq!(receiver.undo(0), Err(SessionError::RecoveryRequired));
    }
}
#[test]
fn local_channel_readonly_views_replay_without_local_history_or_write_permission() {
    let (store, mut a, mut b) = pair();
    b.set_permission(CachedPermission {
        writable: false,
        expires_at: None,
    });
    insert(&mut a, "R");
    b.catch_up_local().unwrap();
    assert_eq!(text(b.document()), "R");
    assert!(matches!(b.state(0).local, LocalState::Committed(_)));
    assert_eq!(b.undo(0), Err(SessionError::ReadOnly));
    assert_eq!(store.pending(&identity()).unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn local_channel_unix_scoped_hints_and_endpoint_ownership() {
    use editac_session::local_channel::unix::UnixLocalChannel;
    let path = std::env::temp_dir().join(format!("lc-scope-{}", std::process::id()));
    std::fs::create_dir_all(&path).unwrap();
    let pa = path.join("a");
    let pb = path.join("b");
    let mut a = UnixLocalChannel::bind(&pa, &identity(), vec![pb.clone()]).unwrap();
    let mut b = UnixLocalChannel::bind(&pb, &identity(), vec![pa.clone()]).unwrap();
    assert!(UnixLocalChannel::bind(&pa, &identity(), vec![]).is_err());
    a.notify(4).unwrap();
    assert_eq!(b.receive().unwrap(), vec![4]);
    std::os::unix::net::UnixDatagram::unbound()
        .unwrap()
        .send_to(&[0; 100], &pb)
        .unwrap();
    assert!(b.receive().unwrap().is_empty());
    let mut wrong = identity();
    wrong.epoch = "34567890-3456-4456-8456-34567890abcd".into();
    let mut c = UnixLocalChannel::bind(path.join("c"), &wrong, vec![pb.clone()]).unwrap();
    c.notify(5).unwrap();
    assert!(b.receive().unwrap().is_empty());
    drop(c);
    drop(a);
    drop(b);
    assert!(!pa.exists() && !pb.exists());
    std::fs::remove_dir(path).unwrap();
}

#[cfg(all(unix, feature = "native-store"))]
mod native {
    use super::*;
    use editac_session::{local_channel::unix::UnixLocalChannel, store::NativeStore};
    use std::{
        path::Path,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    fn wait(path: &Path) {
        let end = Instant::now() + Duration::from_secs(10);
        while !path.exists() {
            assert!(Instant::now() < end, "missing {}", path.display());
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    #[test]
    fn local_channel_process_child() {
        let Some(path) = std::env::var_os("EDITAC_LOCAL_CHANNEL_CHILD") else {
            return;
        };
        let path = std::path::PathBuf::from(path);
        let sockets =
            std::path::PathBuf::from(std::env::var_os("EDITAC_LOCAL_CHANNEL_SOCKETS").unwrap());
        let store =
            NativeStore::open_existing(path.join("store.db"), identity(), StoreLimits::default())
                .unwrap();
        let mut session = Session::open(store, &identity(), CachedPermission::LOCAL).unwrap();
        let mut channel = UnixLocalChannel::bind(
            sockets.join("child.sock"),
            &identity(),
            vec![sockets.join("parent.sock")],
        )
        .unwrap();
        if std::env::var_os("EDITAC_LOCAL_CHANNEL_RESTART").is_some() {
            std::fs::write(
                path.join("restart.writer"),
                session.document().writer_id().to_string(),
            )
            .unwrap();
            std::fs::write(path.join("restart.text"), text(session.document())).unwrap();
            session.notify_local(&mut channel).unwrap();
            return;
        }
        insert(&mut session, "C");
        session.notify_local(&mut channel).unwrap();
        std::fs::write(
            path.join("child.ready"),
            session.document().writer_id().to_string(),
        )
        .unwrap();
        wait(&path.join("parent.ready"));
        assert_eq!(session.receive_local(&mut channel).unwrap(), 1);
        std::fs::write(path.join("child.text"), text(session.document())).unwrap();
    }
    #[test]
    fn local_channel_actual_two_processes_sqlite_offline_restart_and_reconnect() {
        let root = std::env::var_os("EDITAC_LOCAL_CHANNEL_EVIDENCE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let path = root.join(format!("lc-process-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        let sockets = std::path::PathBuf::from(format!("/tmp/editac-lc-{}", std::process::id()));
        std::fs::create_dir(&sockets).unwrap();
        let store =
            NativeStore::create_new(path.join("store.db"), identity(), StoreLimits::default())
                .unwrap();
        store
            .publish(
                0,
                CheckpointRecord::new(support::checkpoint().clone(), vec![]).unwrap(),
            )
            .unwrap();
        let mut session = Session::open(store, &identity(), CachedPermission::LOCAL).unwrap();
        let mut channel = UnixLocalChannel::bind(
            sockets.join("parent.sock"),
            &identity(),
            vec![sockets.join("child.sock")],
        )
        .unwrap();
        let log = std::fs::File::create(path.join("child.log")).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native::local_channel_process_child",
                "--nocapture",
            ])
            .env("EDITAC_LOCAL_CHANNEL_CHILD", &path)
            .env("EDITAC_LOCAL_CHANNEL_SOCKETS", &sockets)
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap();
        wait(&path.join("child.ready"));
        assert_ne!(
            std::fs::read_to_string(path.join("child.ready")).unwrap(),
            session.document().writer_id().to_string()
        );
        assert_eq!(text(session.document()), "");
        assert_eq!(session.receive_local(&mut channel).unwrap(), 1);
        assert_eq!(text(session.document()), "C");
        insert(&mut session, "P");
        session.notify_local(&mut channel).unwrap();
        std::fs::write(path.join("parent.ready"), "ready").unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(
            text(session.document()),
            std::fs::read_to_string(path.join("child.text")).unwrap()
        );
        let restart_log = std::fs::File::create(path.join("restart.log")).unwrap();
        let restart = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native::local_channel_process_child",
                "--nocapture",
            ])
            .env("EDITAC_LOCAL_CHANNEL_CHILD", &path)
            .env("EDITAC_LOCAL_CHANNEL_SOCKETS", &sockets)
            .env("EDITAC_LOCAL_CHANNEL_RESTART", "1")
            .stdout(Stdio::from(restart_log.try_clone().unwrap()))
            .stderr(Stdio::from(restart_log))
            .status()
            .unwrap();
        assert!(restart.success());
        assert_ne!(
            std::fs::read_to_string(path.join("restart.writer")).unwrap(),
            std::fs::read_to_string(path.join("child.ready")).unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(path.join("restart.text")).unwrap(),
            text(session.document())
        );
        assert_eq!(session.receive_local(&mut channel).unwrap(), 0);
        let restarted = Session::open(
            NativeStore::open_existing(path.join("store.db"), identity(), StoreLimits::default())
                .unwrap(),
            &identity(),
            CachedPermission::LOCAL,
        )
        .unwrap();
        assert_ne!(
            restarted.document().writer_id(),
            session.document().writer_id()
        );
        assert_eq!(text(restarted.document()), text(session.document()));
        assert_eq!(restarted.state(0).pending_upload, 2);
        drop(channel);
        assert!(!sockets.join("parent.sock").exists() && !sockets.join("child.sock").exists());
        std::fs::remove_dir(&sockets).unwrap();
        if std::env::var_os("EDITAC_LOCAL_CHANNEL_EVIDENCE").is_none() {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
}
