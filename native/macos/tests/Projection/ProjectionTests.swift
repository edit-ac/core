import AppKit
import XCTest
@testable import EditacMacOS

private struct UnexpectedResponse: Error {}

@MainActor
final class ProjectionTests: XCTestCase {
    private func send(_ view: NativeEditorView, _ request: NativeSessionRequest) async throws -> NativeSessionResponse {
        try await withCheckedThrowingContinuation { continuation in
            do { try view.session.submit(request) { continuation.resume(with: $0.mapError { $0 as Error }) } }
            catch { continuation.resume(throwing: error) }
        }
    }

    private func read(_ view: NativeEditorView) async throws -> NativeSessionRead {
        guard case let .snapshot(value) = try await send(view, .read(now: 0)) else { throw UnexpectedResponse() }
        return value
    }

    private func fixture(_ texts: [String],
                         body: @MainActor (NativeEditorView, NativeSessionRead) async throws -> Void) async throws {
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("editac-projection-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let view = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 500, height: 300))
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
        defer { window.contentView = nil; window.close(); try? FileManager.default.removeItem(at: directory) }
        let options = NativeSessionOptions(path: directory.appendingPathComponent("document.sqlite").path,
            documentId: UUID().uuidString.lowercased(), epoch: UUID().uuidString.lowercased(),
            writable: true, permissionExpiresAt: nil)
        do {
            let response: NativeSessionResponse = try await withCheckedThrowingContinuation { continuation in
                do {
                    try view.session.open(options: options,
                        initial: texts.map { NativeSessionSeed(kind: "block", text: $0) }, now: 0) {
                            continuation.resume(with: $0.mapError { $0 as Error })
                        }
                } catch { continuation.resume(throwing: error) }
            }
            guard case let .snapshot(snapshot) = response else { throw UnexpectedResponse() }
            XCTAssertTrue(view.textView.window === window)
            XCTAssertNil(view.projectionFailure)
            try await body(view, snapshot)
        } catch {
            await withCheckedContinuation { c in view.dispose { c.resume() } }
            throw error
        }
        await withCheckedContinuation { c in view.dispose { c.resume() } }
    }

    private func edit(_ view: NativeEditorView, _ snapshot: NativeSessionRead,
                      node: Int = 0, range: NSRange, text: String) async throws -> NativeSessionRead {
        guard case let .prepared(token) = try await send(view, .prepare(revision: snapshot.revision!,
            edits: [NativeSessionEdit(node: snapshot.nodes[node].id, fromUtf16: UInt32(range.location),
                toUtf16: UInt32(NSMaxRange(range)), text: text)], origin: "appkit-projection-test", now: 0)) else {
            throw UnexpectedResponse()
        }
        _ = try await send(view, .commit(token: token, now: 0))
        return try await read(view)
    }

    func testActualSessionProjectsUnicodeAndMultipleBlocksIntoNativeStorage() async throws {
        try await fixture(["A🦀e\u{301}", "אבג العربية"]) { view, snapshot in
            XCTAssertEqual(view.textView.string, "A🦀e\u{301}\nאבג العربية")
            XCTAssertEqual(view.projection.nodes.map(\.id), snapshot.nodes.map(\.id))
            XCTAssertEqual(view.projection.nodes[1].range.location, 6)
            XCTAssertTrue(view.textView.isEditable)
            XCTAssertFalse(view.textView.allowsUndo)
            XCTAssertEqual(view.sessionSnapshot, snapshot)
        }
    }

    func testIncrementalCommitPreservesIdentityAttributesAndBackwardSelectionOnUnchangedNode() async throws {
        try await fixture(["A🦀B", "אבג"]) { view, before in
            let first = view.projection.nodes[0], second = view.projection.nodes[1]
            let target = try view.projection.capture(range: NSRange(location: 5, length: 2), backwards: true, affinity: .downstream)
            try view.projection.select(target)
            let key = NSAttributedString.Key("test-unchanged-attribute")
            view.textView.textStorage!.addAttribute(key, value: "retained", range: NSRange(location: 5, length: 3))
            let after = try await self.edit(view, before, range: NSRange(location: 1, length: 2), text: "longer")
            XCTAssertEqual(view.textView.string, "AlongerB\nאבג")
            XCTAssertEqual(after.nodes[0].id, before.nodes[0].id)
            XCTAssertTrue(view.projection.nodes[0] === first)
            XCTAssertTrue(view.projection.nodes[1] === second)
            XCTAssertEqual(view.projection.lastPatch, NativeTextStoragePatch(range: NSRange(location: 1, length: 2), replacement: "longer"))
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 9, length: 2))
            XCTAssertEqual(view.projection.selection?.anchor, target.anchor)
            XCTAssertEqual(view.projection.selection?.focus, target.focus)
            XCTAssertEqual(view.textView.textStorage?.attribute(key, at: 9, effectiveRange: nil) as? String, "retained")
            XCTAssertFalse(view.projection.selectionInvalidated)
            XCTAssertThrowsError(try view.projection.select(target)) { XCTAssertEqual($0 as? NativeProjectionFailure, .staleTarget) }
        }
    }

    func testChangedSelectedNodeInvalidatesCoordinatesInsteadOfGuessingAnchors() async throws {
        try await fixture(["A🦀B"]) { view, before in
            let target = try view.projection.capture(range: NSRange(location: 1, length: 2), backwards: true, affinity: .upstream)
            try view.projection.select(target)
            _ = try await self.edit(view, before, range: NSRange(location: 1, length: 2), text: "Z")
            XCTAssertEqual(view.textView.string, "AZB")
            XCTAssertTrue(view.projection.selectionInvalidated)
            XCTAssertNil(view.projection.selection)
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 0, length: 0))
            XCTAssertThrowsError(try view.projection.range(for: target)) { XCTAssertEqual($0 as? NativeProjectionFailure, .staleTarget) }
        }
    }

    func testUTF16RangesRejectSurrogateSplitsAndOverflow() async throws {
        try await fixture(["A🦀e\u{301}"]) { view, _ in
            for range in [NSRange(location: 2, length: 0), NSRange(location: 1, length: 1),
                          NSRange(location: NSNotFound, length: 0), NSRange(location: 0, length: Int.max),
                          NSRange(location: 6, length: 0)] {
                XCTAssertThrowsError(try view.projection.capture(range: range, backwards: false, affinity: .downstream)) {
                    XCTAssertEqual($0 as? NativeProjectionFailure, .invalidRange)
                }
            }
            for range in [NSRange(location: 1, length: 2), NSRange(location: 3, length: 2)] {
                let target = try view.projection.capture(range: range, backwards: false, affinity: .upstream)
                XCTAssertEqual(try view.projection.range(for: target), range)
            }
        }
    }

    func testBidiAnchorFocusDirectionIsIndependentOfAffinity() async throws {
        try await fixture(["abc אבג العربية"]) { view, _ in
            for affinity in [NSSelectionAffinity.upstream, .downstream] {
                for backwards in [false, true] {
                    let range = NSRange(location: 4, length: 3)
                    let target = try view.projection.capture(range: range, backwards: backwards, affinity: affinity)
                    XCTAssertEqual(target.anchor.offsetUTF16, backwards ? 7 : 4)
                    XCTAssertEqual(target.focus.offsetUTF16, backwards ? 4 : 7)
                    try view.projection.select(target)
                    XCTAssertEqual(view.textView.selectedRange(), range)
                    XCTAssertEqual(view.projection.selection?.affinity, affinity)
                }
            }
        }
    }

    func testCrossBlockSelectionAndSyntheticSeparatorCoordinates() async throws {
        try await fixture(["A🦀", "בB"]) { view, snapshot in
            let range = NSRange(location: 1, length: 4)
            let target = try view.projection.capture(range: range, backwards: true, affinity: .downstream)
            XCTAssertEqual(target.anchor.node, snapshot.nodes[1].id)
            XCTAssertEqual(target.anchor.offsetUTF16, 1)
            XCTAssertEqual(target.focus.node, snapshot.nodes[0].id)
            XCTAssertEqual(target.focus.offsetUTF16, 1)
            XCTAssertEqual(try view.projection.range(for: target), range)
            let separator = try view.projection.capture(range: NSRange(location: 3, length: 1), backwards: false, affinity: .downstream)
            XCTAssertEqual(separator.anchor.offsetUTF16, 3)
            XCTAssertEqual(separator.focus.offsetUTF16, 0)
            XCTAssertEqual(try view.projection.range(for: separator), NSRange(location: 3, length: 1))
        }
    }

    func testCanonicallyEquivalentUnicodeStillChangesExactStorageUnits() async throws {
        try await fixture(["é"]) { view, before in
            _ = try await self.edit(view, before, range: NSRange(location: 0, length: 1), text: "e\u{301}")
            XCTAssertEqual(Array(view.textView.string.utf16), [0x65, 0x301])
            XCTAssertEqual(view.projection.lastPatch?.range, NSRange(location: 0, length: 1))
            XCTAssertEqual(view.projection.nodes[0].range.length, 2)
        }
    }

    func testRepeatedReadDoesNotReplaceStorageAndCrossViewTargetIsRejected() async throws {
        try await fixture(["text"]) { view, _ in
            let target = try view.projection.capture(range: NSRange(location: 1, length: 2), backwards: true, affinity: .upstream)
            try view.projection.select(target)
            _ = try await self.read(view)
            XCTAssertNil(view.projection.lastPatch)
            XCTAssertEqual(view.projection.selection, target)
            let other = NativeTextProjection(textView: NSTextView())
            try other.apply(view.sessionSnapshot!)
            XCTAssertThrowsError(try other.select(target)) { XCTAssertEqual($0 as? NativeProjectionFailure, .staleTarget) }
        }
    }

    // Prepared malformed/future-boundary DTO cases; not rich-content integration.
    func testPreparedUnsupportedAndDuplicateNodesFailBeforeStorageMutation() async throws {
        try await fixture(["retained"]) { view, original in
            var unsupported = original
            unsupported.nodes.append(NativeSessionNode(id: "unavailable-atom", kind: "image", text: ""))
            XCTAssertThrowsError(try view.projection.apply(unsupported)) {
                XCTAssertEqual($0 as? NativeProjectionFailure, .unsupportedKind("image"))
            }
            var duplicate = original; duplicate.nodes += original.nodes
            XCTAssertThrowsError(try view.projection.apply(duplicate)) {
                XCTAssertEqual($0 as? NativeProjectionFailure, .duplicateIdentity)
            }
            XCTAssertEqual(view.textView.string, "retained")
            XCTAssertEqual(view.projection.nodes.count, 1)
        }
    }

    func testPreparedUnacknowledgedRevisionAndDisposedProjectionCannotMintTargets() async throws {
        try await fixture(["text"]) { view, original in
            var recovery = original; recovery.revision = nil; recovery.recoveryRequired = true
            try view.projection.apply(recovery)
            XCTAssertThrowsError(try view.projection.capture(range: NSRange(location: 0, length: 0), backwards: false, affinity: .upstream)) {
                XCTAssertEqual($0 as? NativeProjectionFailure, .unavailableRevision)
            }
            view.projection.dispose()
            XCTAssertThrowsError(try view.projection.apply(original)) { XCTAssertEqual($0 as? NativeProjectionFailure, .disposed) }
            XCTAssertEqual(view.textView.string, "text")
        }
    }

    private func richFixture(body: @MainActor (NativeEditorView, NativeSessionRead) async throws -> Void) async throws {
        _ = NSApplication.shared
        guard let manifest = ProcessInfo.processInfo.environment["EDITAC_MACOS_RICH_FIXTURE"] else {
            XCTFail("Missing real Rust/SQLite rich fixture; no skip or DTO substitute"); return
        }
        let value = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: manifest))) as! [String: Any]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("editac-rich-appkit-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = directory.appendingPathComponent("document.sqlite")
        try FileManager.default.copyItem(atPath: value["path"] as! String, toPath: store.path)
        let view = NativeEditorView(frame: NSRect(x: 0, y: 0, width: 500, height: 300))
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
        defer { window.contentView = nil; window.close(); try? FileManager.default.removeItem(at: directory) }
        let options = NativeSessionOptions(path: store.path, documentId: value["documentId"] as! String,
            epoch: value["epoch"] as! String, writable: true, permissionExpiresAt: nil)
        do {
            let response: NativeSessionResponse = try await withCheckedThrowingContinuation { continuation in
                do { try view.session.open(options: options, now: 0) { continuation.resume(with: $0.mapError { $0 as Error }) } }
                catch { continuation.resume(throwing: error) }
            }
            guard case let .snapshot(snapshot) = response else { throw UnexpectedResponse() }
            XCTAssertNil(view.projectionFailure)
            try await body(view, snapshot)
            await withCheckedContinuation { continuation in view.dispose { continuation.resume() } }
        } catch {
            await withCheckedContinuation { continuation in view.dispose { continuation.resume() } }
            throw error
        }
    }

    func testRichSessionSnapshotMapsSharedRunsAndNativeAttachmentWithoutFetching() async throws {
        try await richFixture { view, snapshot in
            XCTAssertEqual(view.textView.string, "A🦀אב\n\u{FFFC}\ntail e\u{301} שלום")
            XCTAssertEqual(view.projection.nodes.map(\.id), snapshot.nodes.map(\.id))
            let atom = view.projection.nodes[1]
            XCTAssertEqual(atom.range, NSRange(location: 6, length: 1))
            XCTAssertNotNil(view.textView.textStorage!.attribute(.attachment, at: 6, effectiveRange: nil))
            let descriptor = view.textView.textStorage!.attribute(NativeTextProjection.sharedNodeAttributes, at: 6, effectiveRange: nil) as! NSDictionary
            XCTAssertEqual((descriptor["blockAttributes"] as! [Any])[0] as? String, "module:editac.image")
            let shared = view.textView.textStorage!.attribute(NativeTextProjection.sharedRunAttributes, at: 0, effectiveRange: nil) as! NSDictionary
            XCTAssertGreaterThan(shared.count, 0)
            XCTAssertEqual(view.projection.richNodes[atom.id]?.wire["spans"] is [[String: Any]], true)
            XCTAssertEqual(view.projection.attachmentIdentities.count, 1)
        }
    }

    func testRichPatchesPreserveChangedNodeSelectionUsingSharedAnchorsAndDirection() async throws {
        try await richFixture { view, before in
            let node = view.projection.nodes[0]
            try await view.select(range: NSRange(location: 3, length: 2), backwards: true, affinity: .upstream)
            let stale = view.projection.selection!
            let after = try await self.edit(view, before, range: NSRange(location: 0, length: 0), text: "😀")
            XCTAssertEqual(view.textView.string, "😀A🦀אב\n\u{FFFC}\ntail e\u{301} שלום")
            XCTAssertTrue(view.projection.nodes[0] === node)
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 5, length: 2))
            XCTAssertEqual(view.projection.selection?.anchor.offsetUTF16, 7)
            XCTAssertEqual(view.projection.selection?.focus.offsetUTF16, 5)
            XCTAssertEqual(view.projection.selection?.affinity, .upstream)
            XCTAssertEqual(view.projection.selection?.revision, after.revision)
            XCTAssertFalse(view.projection.selectionInvalidated)
            XCTAssertThrowsError(try view.projection.select(stale))
        }
    }

    func testAttachmentEdgesAndCrossNodeAnchorsSurviveChangedUnicodeText() async throws {
        try await richFixture { view, before in
            let atom = view.projection.nodes[1], attachment = view.projection.attachmentIdentities[view.projection.nodes[1].id]!
            try await view.select(range: NSRange(location: 6, length: 1), backwards: true, affinity: .downstream)
            XCTAssertEqual(view.projection.selection?.anchor.offsetUTF16, 1)
            _ = try await self.edit(view, before, range: NSRange(location: 0, length: 0), text: "X")
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 7, length: 1))
            XCTAssertEqual(view.projection.selection?.anchor.offsetUTF16, 1)
            XCTAssertEqual(view.projection.selection?.focus.offsetUTF16, 0)
            XCTAssertTrue(view.projection.nodes[1] === atom)
            XCTAssertTrue(view.projection.attachmentIdentities[atom.id] === attachment)
            let current = try await self.read(view)
            try await view.select(range: NSRange(location: 4, length: 7), backwards: false, affinity: .upstream)
            _ = try await self.edit(view, current, range: NSRange(location: 0, length: 1), text: "long")
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 7, length: 7))
            XCTAssertFalse(view.projection.selectionInvalidated)
        }
    }

    func testRichRangeBatchPreservesMiddleAttachmentAndUntouchedNativeAttributes() async throws {
        try await richFixture { view, before in
            let atom = view.projection.nodes[1], attachment = view.projection.attachmentIdentities[view.projection.nodes[1].id]!
            let key = NSAttributedString.Key("test-retained-middle")
            view.textView.textStorage!.addAttribute(key, value: "retained", range: atom.range)
            let sequence = view.projection.richSequence!
            guard case let .prepared(token) = try await self.send(view, .prepare(revision: before.revision!,
                edits: [NativeSessionEdit(node: before.nodes[0].id, fromUtf16: 0, toUtf16: 0, text: "X"),
                        NativeSessionEdit(node: before.nodes[2].id, fromUtf16: 0, toUtf16: 0, text: "Y")],
                origin: "multi-range-patch", now: 0)) else { throw UnexpectedResponse() }
            _ = try await self.send(view, .commit(token: token, now: 0))
            _ = try await self.read(view)
            XCTAssertEqual(view.projection.richSequence, sequence + 1)
            XCTAssertTrue(view.projection.nodes[1] === atom)
            XCTAssertTrue(view.projection.attachmentIdentities[atom.id] === attachment)
            XCTAssertEqual(view.textView.textStorage!.attribute(key, at: atom.range.location, effectiveRange: nil) as? String, "retained")
            XCTAssertEqual(view.textView.string, "XA🦀אב\n\u{FFFC}\nYtail e\u{301} שלום")
        }
    }

    func testSharedAnchoredSelectionDeletionAndUndoRedoUseEnginePositions() async throws {
        try await richFixture { view, before in
            try await view.select(range: NSRange(location: 3, length: 2), backwards: true, affinity: .downstream)
            let after = try await self.edit(view, before, range: NSRange(location: 1, length: 4), text: "")
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 1, length: 0))
            XCTAssertFalse(view.projection.selectionInvalidated)
            _ = try await self.send(view, .undo(revision: after.revision!, now: 0))
            let undone = try await self.read(view)
            XCTAssertEqual(view.textView.string, "A🦀אב\n\u{FFFC}\ntail e\u{301} שלום")
            XCTAssertNotNil(view.projection.selection, "shared=\(view.projection.selectionResolutions), invalid=\(view.projection.selectionInvalidated), failure=\(String(describing: view.projectionFailure))")
            _ = try await self.send(view, .redo(revision: undone.revision!, now: 0))
            _ = try await self.read(view)
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 1, length: 0))
            XCTAssertNil(view.projectionFailure)
        }
    }

    func testResnapshotPreservesSharedAnchorsAndAttachmentIdentity() async throws {
        try await richFixture { view, _ in
            let node = view.projection.nodes[1], attachment = view.projection.attachmentIdentities[view.projection.nodes[1].id]!
            try await view.select(range: NSRange(location: 3, length: 2), backwards: true, affinity: .upstream)
            _ = try await self.send(view, .resyncProjection)
            _ = try await self.read(view)
            XCTAssertTrue(view.projection.nodes[1] === node)
            XCTAssertTrue(view.projection.attachmentIdentities[node.id] === attachment)
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 3, length: 2))
            XCTAssertTrue(view.projection.anchoredSelection)
            XCTAssertNil(view.projection.lastPatch)
        }
    }

    func testPreparedRichCursorAndLineageFailuresAreAtomic() async throws {
        try await richFixture { view, _ in
            let text = view.textView.string, nodes = view.projection.nodes
            let cursor = view.projection.richSequence!
            for patches in [
                NativeSessionPatches(revision: Data([1]), afterSequence: cursor + 1, sequence: cursor + 1, patchesJson: []),
                NativeSessionPatches(revision: Data([1]), afterSequence: cursor, sequence: cursor + 1, patchesJson: ["{}"]),
                NativeSessionPatches(revision: Data([1]), afterSequence: cursor, sequence: cursor, patchesJson: ["not json"])
            ] {
                XCTAssertThrowsError(try view.projection.apply(NativeProjectionUpdate(snapshot: nil, patches: patches, selection: [])))
                XCTAssertEqual(view.textView.string, text)
                XCTAssertEqual(view.projection.richSequence, cursor)
                XCTAssertTrue(view.projection.nodes[0] === nodes[0])
            }
        }
    }

    func testDisposedRichProjectionRejectsLateSnapshotAndReleasesAttachments() async throws {
        try await richFixture { view, _ in
            let text = view.textView.string
            view.projection.dispose()
            XCTAssertTrue(view.projection.attachmentIdentities.isEmpty)
            _ = try await self.read(view)
            XCTAssertEqual(view.projectionFailure, .disposed)
            XCTAssertEqual(view.textView.string, text)
        }
    }

    func testSharedCaptureRejectsStaleProjectedRevisionBeforeRefresh() async throws {
        try await richFixture { view, before in
            guard case let .prepared(token) = try await self.send(view, .prepare(revision: before.revision!,
                edits: [NativeSessionEdit(node: before.nodes[0].id, fromUtf16: 0, toUtf16: 0, text: "X")],
                origin: "capture-stale", now: 0)) else { throw UnexpectedResponse() }
            _ = try await self.send(view, .commit(token: token, now: 0))
            do {
                try await view.select(range: NSRange(location: 3, length: 2), backwards: true, affinity: .upstream)
                XCTFail("Stale projection admitted a shared capture")
            } catch NativeSessionFailure.native(.Revision) {} catch { XCTFail("Wrong typed error: \(error)") }
            _ = try await self.read(view)
            XCTAssertEqual(view.textView.string, "XA🦀אב\n\u{FFFC}\ntail e\u{301} שלום")
            XCTAssertFalse(view.projection.anchoredSelection)
            XCTAssertNil(view.projectionFailure)
        }
    }

    func testPreparedUnresolvableSharedSelectionInvalidatesWithoutGuessing() async throws {
        try await richFixture { view, before in
            try await view.select(range: NSRange(location: 3, length: 2), backwards: true, affinity: .upstream)
            let sequence = view.projection.richSequence!
            let resolved = NativeSessionAnchorRead(documentId: "foreign", epoch: "foreign",
                revision: before.revision!, resolution: .unresolvable(reason: "InvalidBoundary"))
            let patches = NativeSessionPatches(revision: before.revision!, afterSequence: sequence,
                sequence: sequence, patchesJson: [])
            try view.projection.apply(NativeProjectionUpdate(snapshot: nil, patches: patches, selection: [resolved, resolved]))
            XCTAssertTrue(view.projection.selectionInvalidated)
            XCTAssertNil(view.projection.selection)
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 0, length: 0))
            XCTAssertEqual(view.projection.selectionResolutions, [resolved, resolved])
        }
    }

    func testNativeCaretChangeSupersedesCapturedAnchorsAcrossRepeatedReads() async throws {
        try await richFixture { view, _ in
            try await view.select(range: NSRange(location: 3, length: 2), backwards: true, affinity: .upstream)
            view.textView.setSelectedRange(NSRange(location: 8, length: 0))
            _ = try await self.read(view)
            XCTAssertFalse(view.projection.anchoredSelection)
            _ = try await self.read(view)
            XCTAssertEqual(view.textView.selectedRange(), NSRange(location: 8, length: 0))
            XCTAssertFalse(view.projection.anchoredSelection)
            XCTAssertNil(view.projectionFailure)
        }
    }

    func testPreparedViewProjectionFailureInvalidatesOldTargetsAndResyncRecovers() async throws {
        try await richFixture { view, _ in
            let text = view.textView.string
            let cursor = view.projection.richSequence!
            let malformed = NativeSessionPatches(revision: Data([1]), afterSequence: cursor + 1,
                sequence: cursor + 1, patchesJson: [])
            view.session.onProjection?(.success(NativeProjectionUpdate(snapshot: nil, patches: malformed, selection: [])))
            XCTAssertEqual(view.projectionFailure, .invalidCursor)
            XCTAssertEqual(view.textView.string, text)
            XCTAssertThrowsError(try view.projection.capture(range: NSRange(location: 0, length: 0), backwards: false, affinity: .upstream)) {
                XCTAssertEqual($0 as? NativeProjectionFailure, .unavailableRevision)
            }
            _ = try await self.send(view, .resyncProjection)
            _ = try await self.read(view)
            XCTAssertNil(view.projectionFailure)
            XCTAssertEqual(view.textView.string, text)
        }
    }

}
