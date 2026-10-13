import ac.edit.nativebridge.*
import com.google.gson.*
import java.io.File

// Only populated by the disposable instrumented binding build, on this serial host.
object BoundaryProbe {
    val events = linkedMapOf<String, Int>()
    val bytes = linkedMapOf<String, Int>()
    fun record(key: String, size: Int = 0) {
        events[key] = (events[key] ?: 0) + 1
        bytes[key] = (bytes[key] ?: 0) + size
    }
    fun reset() { events.clear(); bytes.clear() }
}
private val gson = Gson()
private fun json(value: Any?): String = gson.toJson(value)
private fun obj(value: String): JsonObject = JsonParser.parseString(value).asJsonObject
private fun requireProbe(value: Boolean, message: String) { check(value) { message } }
private fun expectError(kind: String, action: () -> Unit) {
    try { action() } catch (e: NativeException) {
        requireProbe(e.javaClass.simpleName == kind, "expected $kind, got ${e.javaClass.simpleName}")
        return
    }
    error("expected typed $kind")
}
private lateinit var fixture: JsonObject
private fun field(name: String) = fixture[name].asString
private fun number(name: String) = fixture[name].asInt
private fun create(serial: Int) = NativeEngine.create(json(mapOf(
    "profile" to field("profile"), "epoch" to field("epoch"),
    "documentId" to "a8000000-0000-4000-8000-%012d".format(serial),
    "nodes" to listOf(mapOf("text" to field("initialText")))
)))
private fun snapshot(e: NativeEngine) = obj(e.read()).apply { remove("changedNodes"); remove("touchedRanges") }
private fun text(s: JsonObject) = s["visible"].asJsonArray[0].asJsonObject["runs"].asJsonArray.joinToString("") { it.asJsonObject["text"].asString }
private fun anchor(e: NativeEngine, offset: Int) = e.captureAnchor(AnchorInput(snapshot(e)["visible"].asJsonArray[0].asJsonObject["id"].asString, offset.toUInt(), AnchorBias.RIGHT))
private fun commands(e: NativeEngine) = json(mapOf("kind" to "editor", "origin" to "native-fixture", "commands" to listOf(
    mapOf("type" to "insert", "at" to anchor(e, number("insertOffsetUtf16")), "text" to field("insertText")),
    mapOf("type" to "insert", "at" to anchor(e, number("suffixOffsetUtf16")), "text" to field("suffixText"))
)))
private fun restoreInput(c: OwnedCheckpoint) = obj(c.metadataJson).apply { add("expected", get("identity")); add("journal", JsonArray()) }.toString()
private fun restore(e: NativeEngine): NativeEngine { val c = e.checkpoint(); return NativeEngine.restore(restoreInput(c), c.bytes) }
private fun <T> engine(serial: Int, action: (NativeEngine) -> T): T = create(serial).use { e ->
    try { action(e) } finally { e.dispose() }
}
fun main(args: Array<String>) {
    fixture = obj(File(args[0]).readText())
    val initial = field("initialText"); val expected = field("expectedText")
    val cases = linkedMapOf<String, () -> Map<String, Any>>()
    cases["schema"] = {
        val v = abiVersion()
        requireProbe(v.abiVersion == 1u && v.offsetUnits == "utf16" && v.updateEncoding == 1u && v.uniffiVersion == "0.32.2", "ABI versions")
        requireProbe(v.schema == "editac.registry.editor.v5" && v.profile == "editac.yrs-yjs.editor.v5", "schema/profile")
        mapOf("abi" to 1, "offsets" to v.offsetUnits, "uniffi" to v.uniffiVersion)
    }
    cases["unicode-batch-patch"] = { engine(1) { e ->
        val before = snapshot(e); val checkpoint = e.checkpoint(); val saved = checkpoint.bytes.copyOf()
        requireProbe(text(before) == initial && initial.length == number("initialUtf16Units"), "initial Unicode")
        val end = anchor(e, number("suffixOffsetUtf16"))
        val result = e.executeBatch(commands(e)); val patch = obj(result.patchJson); val actual = text(snapshot(e))
        requireProbe(actual == expected && actual.length == number("expectedUtf16Units"), "UTF-16 batch semantics")
        requireProbe(patch["version"].asInt == 1 && patch["sequence"].asInt == 1, "patch version/sequence")
        requireProbe(patch["changedNodes"].asJsonArray.size() == 1 && patch["nodes"].asJsonArray.size() == 1, "one detached patch node")
        requireProbe(patch["identity"].asJsonObject["offsets"].asString == "utf16", "patch offsets")
        requireProbe(obj(e.resolveAnchor(end))["offset"].asInt == actual.length, "relative end anchor")
        requireProbe(e.takePatch() == "null", "synchronous patch consumed")
        e.dispose()
        requireProbe(checkpoint.bytes.contentEquals(saved) && saved.isNotEmpty() && text(before) == initial, "owned output survives disposal")
        mapOf("expectedText" to expected, "actualText" to actual, "utf16" to actual.length, "patchVersion" to 1, "changedNodes" to 1, "checkpointBytes" to saved.size)
    } }
    cases["checkpoint-restore"] = { engine(2) { e ->
        e.executeBatch(commands(e)); val c = e.checkpoint()
        NativeEngine.restore(restoreInput(c), c.bytes).use { r ->
            try {
                val left = snapshot(e); val right = snapshot(r)
                requireProbe(text(right) == expected && left["identity"] == right["identity"] && e.stateVector().contentEquals(r.stateVector()), "checkpoint identity/vector/text")
                requireProbe(obj(c.metadataJson)["writerId"] != obj(r.checkpoint().metadataJson)["writerId"], "new restore writer")
                val bad = obj(restoreInput(c)); bad["expected"].asJsonObject.addProperty("offsets", "utf8")
                expectError("EngineRejected") { NativeEngine.restore(bad.toString(), c.bytes).close() }
                mapOf("actualText" to text(right), "identityPreserved" to true, "newWriter" to true, "rejectedOffsets" to "utf8")
            } finally { r.dispose() }
        }
    } }
    cases["remote-update-anchor-history"] = { engine(3) { e ->
        restore(e).use { r -> try {
            val imported = r.importAnchor(e.exportAnchor(anchor(e, number("insertOffsetUtf16"))))
            val vector = r.stateVector(); e.executeBatch(commands(e)); val update = e.encodeUpdate(vector)
            requireProbe(update.isNotEmpty(), "real update bytes")
            val result = r.applyUpdate(snapshot(e)["identity"].toString(), update)
            requireProbe(obj(result.patchJson)["operation"].asString == "Remote" && text(snapshot(r)) == expected, "remote semantics")
            requireProbe(obj(r.resolveAnchor(imported))["offset"].asInt == 4, "portable anchor")
            r.releaseAnchor(imported); expectError("InvalidHandle") { r.resolveAnchor(imported) }
            val undo = e.history(json(mapOf("type" to "undo")))
            requireProbe(undo.patchJson != "null" && text(snapshot(e)) == initial, "history semantics")
            mapOf("actualText" to expected, "updateBytes" to update.size, "stateVectorBytes" to vector.size, "operation" to "Remote", "anchorOffset" to 4, "undoText" to initial)
        } finally { r.dispose() } }
    } }
    cases["typed-pre-mutation-errors"] = { engine(4) { e ->
        val before = snapshot(e); val at = anchor(e, 3)
        val bad = json(mapOf("kind" to "editor", "origin" to "native-fixture", "commands" to listOf(
            mapOf("type" to "insert", "at" to at, "text" to "X"), mapOf("type" to "insert", "at" to "missing", "text" to "Y"))))
        expectError("InvalidHandle") { e.executeBatch(bad) }
        expectError("EngineRejected") { anchor(e, number("invalidSurrogateOffsetUtf16")) }
        expectError("InvalidInput") { e.executeBatch("{") }
        expectError("InvalidInput") { NativeEngine.create("{}").close() }
        expectError("ResourceLimit") { e.executeBatch(" ".repeat(2 * 1024 * 1024 + 1)) }
        requireProbe(snapshot(e) == before && e.takePatch() == "null", "errors preserve state/no patch")
        mapOf("types" to listOf("InvalidHandle", "EngineRejected", "InvalidInput", "ResourceLimit"), "atomic" to true)
    } }
    cases["cancel-commit-dispose"] = { engine(5) { e ->
        val alias = e; val input = commands(e); val before = snapshot(e); val canceled = e.prepareBatch(input)
        requireProbe(snapshot(e) == before, "prepare does not mutate")
        e.cancelBatch(canceled); e.cancelBatch(canceled); expectError("InvalidHandle") { e.commitBatch(canceled) }
        requireProbe(snapshot(e) == before, "cancel does not mutate")
        val token = e.prepareBatch(input); val result = e.commitBatch(token)
        requireProbe(result.patchJson != "null" && text(snapshot(e)) == expected, "prepared commit")
        expectError("InvalidHandle") { e.commitBatch(token) }
        val owned = e.checkpoint(); e.dispose(); e.dispose()
        expectError("Disposed") { alias.read() }; expectError("Disposed") { e.commitBatch(token) }; expectError("Disposed") { e.cancelBatch("missing") }
        requireProbe(owned.bytes.isNotEmpty(), "owned bytes survive dispose")
        mapOf("idempotentCancel" to true, "singleCommit" to true, "aliasDisposed" to true, "ownedBytes" to owned.bytes.size)
    } }
    cases["explicit-close"] = {
        val e = create(6); requireProbe(text(snapshot(e)) == initial, "usable before close"); e.close(); e.close()
        val rejection = runCatching { e.read() }.exceptionOrNull()
        requireProbe(rejection is IllegalStateException && e.uniffiIsDestroyed, "closed handle rejected")
        mapOf("idempotentClose" to true, "closedHandleRejected" to true, "rustJoin" to "Rust Drop joins executor; JVM GC timing is not qualified")
    }
    cases["all-byte-values"] = {
        val bytes = ByteArray(256) { it.toByte() }; val value = OwnedCheckpoint("byte-codec-fixture", bytes)
        val lifted = FfiConverterTypeOwnedCheckpoint.lift(FfiConverterTypeOwnedCheckpoint.lower(value))
        requireProbe(lifted.metadataJson == value.metadataJson && lifted.bytes.contentEquals(bytes), "generated codec preserves all byte values")
        mapOf("byteValues" to 256, "scope" to "generated lower/lift codec; engine separately uses real CRDT bytes")
    }
    cases["boundary-copies"] = { engine(7) { e ->
        val input = commands(e); BoundaryProbe.reset(); val result = e.executeBatch(input)
        val calls = BoundaryProbe.events.toMap(); val sizes = BoundaryProbe.bytes.toMap()
        requireProbe(calls["call.executeBatch"] == 1 && calls.filterKeys { it.startsWith("call.") }.size == 1, "one batched engine call")
        requireProbe(calls["copy.string-to-rust"] == 1 && sizes["copy.string-to-rust"] == input.toByteArray().size, "one input boundary copy")
        requireProbe(calls["copy.string-field"] == 2 && sizes["copy.string-field"] == result.resultJson.toByteArray().size + result.patchJson.toByteArray().size, "two owned output strings")
        val c = e.checkpoint(); val metadata = restoreInput(c); BoundaryProbe.reset()
        val r = NativeEngine.restore(metadata, c.bytes)
        val restoreCalls = BoundaryProbe.events.toMap(); val restoreSizes = BoundaryProbe.bytes.toMap()
        try {
            requireProbe(restoreCalls["call.restore"] == 1 && restoreCalls["copy.string-to-rust"] == 1 && restoreCalls["copy.bytes-to-rust"] == 1, "restore calls/copies")
            requireProbe(restoreSizes["copy.bytes-to-rust"] == c.bytes.size && restoreSizes["copy.string-to-rust"] == metadata.toByteArray().size, "restore sizes")
        } finally { r.dispose(); r.close() }
        mapOf("batchCalls" to calls, "batchBytes" to sizes, "restoreCalls" to restoreCalls, "restoreBytes" to restoreSizes, "scope" to "observed generated allocation/copy sites only; excludes Rust staging, allocator internals and timing")
    } }
    val filter = args.getOrNull(1)
    val chosen = cases.filterKeys { if (filter == null) it != "boundary-copies" else it == filter }
    if (chosen.isEmpty()) { System.err.println("zero matching cases"); kotlin.system.exitProcess(2) }
    val results = chosen.map { (name, run) -> try {
        mapOf("id" to name, "passed" to true, "observations" to run())
    } catch (e: Throwable) { mapOf("id" to name, "passed" to false, "error" to e.toString()) } }
    val failed = results.count { it["passed"] == false }
    println(json(mapOf("cases" to results, "counts" to mapOf("executed" to results.size, "passed" to results.size - failed, "failed" to failed, "skipped" to 0))))
    kotlin.system.exitProcess(if (failed == 0) 0 else 1)
}
