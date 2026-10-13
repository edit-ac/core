package ac.edit.controlprobe

import BoundaryProbe
import ac.edit.nativebridge.*
import android.app.Activity
import android.os.Bundle
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.ImageSpan
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import com.google.gson.*
import java.io.File

private val gson = Gson()
private fun json(v: Any?) = gson.toJson(v)
private fun obj(s: String) = JsonParser.parseString(s).asJsonObject
private fun text(s: JsonObject) = s["visible"].asJsonArray[0].asJsonObject["runs"].asJsonArray.joinToString("") { it.asJsonObject["text"].asString }

// The control owns temporary composing text only. Rust owns committed state.
// This preparation presenter queues remote output and explicitly cancels composition.
private class Presenter(val view: EditText) {
    var pending: String? = null
    val copies = mutableListOf<Map<String, Any>>()
    fun apply(patch: String) {
        val editable = view.editableText
        if (BaseInputConnection.getComposingSpanStart(editable) >= 0) { pending = patch; return }
        val p = obj(patch)
        check(p["version"].asInt == 1) { "patch version" }
        val entry = p["nodes"].asJsonArray.single().asJsonObject
        check(entry["type"].asString == "visible") { "one visible patched node" }
        val node = entry["node"].asJsonObject
        val next = node["runs"].asJsonArray.joinToString("") { it.asJsonObject["text"].asString }
        val old = editable.toString()
        var start = 0
        while (start < old.length && start < next.length && old[start] == next[start]) start++
        if (start > 0 && start < old.length && old[start].isLowSurrogate()) start--
        var oldEnd = old.length; var newEnd = next.length
        while (oldEnd > start && newEnd > start && old[oldEnd - 1] == next[newEnd - 1]) { oldEnd--; newEnd-- }
        if (oldEnd < old.length && old[oldEnd].isLowSurrogate()) { oldEnd++; newEnd++ }
        val a = view.selectionStart; val b = view.selectionEnd
        fun remap(offset: Int) = when {
            offset < start -> offset
            offset >= oldEnd -> offset + newEnd - oldEnd
            else -> newEnd
        }.coerceIn(0, next.length)
        val replacement = next.substring(start, newEnd)
        editable.replace(start, oldEnd, replacement)
        view.setSelection(remap(a), remap(b))
        check(view.text.toString() == next) { "range patch projection" }
        copies += mapOf("operation" to p["operation"].asString, "projectionUtf16" to next.length,
            "oldControlUtf16" to old.length, "replacementUtf16" to replacement.length,
            "rangeStart" to start, "removedUtf16" to oldEnd - start, "patchJsonUtf8" to patch.toByteArray().size)
    }
    fun cancelAndFlush(committed: String) {
        BaseInputConnection.removeComposingSpans(view.editableText)
        view.setText(committed); view.setSelection(committed.length)
        val patch = pending; pending = null
        if (patch != null) apply(patch)
    }
}

class ProbeActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val view = EditText(this)
        view.setSingleLine(false); setContentView(view); view.requestFocus()
        view.post { runProbe(view) }
    }
    private fun runProbe(view: EditText) {
        val results = mutableListOf<Map<String, Any?>>()
        val filter = intent.getStringExtra("case")
        val fixture = obj(assets.open("bounded-abi.json").bufferedReader().use { it.readText() })
        val initial = fixture["initialText"].asString; val expected = fixture["expectedText"].asString
        var engine: NativeEngine? = null; var peer: NativeEngine? = null
        val presenter = Presenter(view)
        fun checkCase(id: String, action: () -> Map<String, Any>) {
            if (filter != null && filter != id) return
            try { results += mapOf("id" to id, "passed" to true, "observations" to action()) }
            catch (e: Throwable) { results += mapOf("id" to id, "passed" to false, "error" to e.stackTraceToString()) }
        }
        try {
            engine = NativeEngine.create(json(mapOf("profile" to fixture["profile"].asString, "epoch" to fixture["epoch"].asString,
                "documentId" to "a9000000-0000-4000-8000-000000000016", "nodes" to listOf(mapOf("text" to initial)))))
            val e = engine
            val c = e.checkpoint(); val metadata = obj(c.metadataJson).apply { add("expected", get("identity")); add("journal", JsonArray()) }
            peer = NativeEngine.restore(metadata.toString(), c.bytes)
            val r = peer
            fun read(e: NativeEngine) = obj(e.read())
            fun insert(e: NativeEngine, offset: Int, value: String): Map<String, Any> {
                val id = read(e)["visible"].asJsonArray[0].asJsonObject["id"].asString
                return mapOf("type" to "insert", "at" to e.captureAnchor(AnchorInput(id, offset.toUInt(), AnchorBias.RIGHT)), "text" to value)
            }
            fun batch(e: NativeEngine, commands: List<Map<String, Any>>): BatchResult {
                try { return e.executeBatch(json(mapOf("kind" to "editor", "origin" to "android-control", "commands" to commands))) }
                finally { commands.forEach { e.releaseAnchor(it["at"] as String) } }
            }
            view.setText(initial); view.setSelection(initial.length)
            checkCase("native-control-unicode") {
                check(view.javaClass == EditText::class.java && view.editableText is android.text.Editable)
                check(view.text.toString() == initial && view.text.length == fixture["initialUtf16Units"].asInt)
                check(abiVersion().offsetUnits == "utf16")
                mapOf("control" to view.javaClass.name, "utf16" to view.text.length, "webView" to false)
            }
            checkCase("local-batched-range-selection") {
                val commands = listOf(insert(e, 3, fixture["insertText"].asString), insert(e, 6, fixture["suffixText"].asString))
                BoundaryProbe.reset(); val patch = batch(e, commands)
                val calls = BoundaryProbe.events.toMap(); val bytes = BoundaryProbe.bytes.toMap()
                check(calls["call.executeBatch"] == 1 && calls["call.releaseAnchor"] == 2 && calls["copy.string-to-rust"] == 3 && calls["copy.string-field"] == 2)
                presenter.apply(patch.patchJson)
                check(view.text.toString() == expected && view.selectionStart == 8 && view.selectionEnd == 8)
                check(text(read(e)) == expected)
                mapOf("text" to expected, "selection" to 8, "calls" to calls, "bytes" to bytes)
            }
            checkCase("remote-crdt-range-selection") {
                val vector = r.stateVector(); val sync = e.encodeUpdate(vector); r.applyUpdate(read(e)["identity"].toString(), sync)
                val remote = batch(r, listOf(insert(r, 0, "R")))
                val update = r.encodeUpdate(e.stateVector())
                val identity = read(r)["identity"].toString()
                BoundaryProbe.reset(); val patch = e.applyUpdate(identity, update)
                val calls = BoundaryProbe.events.toMap(); val bytes = BoundaryProbe.bytes.toMap()
                check(calls["call.applyUpdate"] == 1 && calls["copy.bytes-to-rust"] == 1 && bytes["copy.bytes-to-rust"] == update.size)
                check(obj(patch.patchJson)["operation"].asString == "Remote" && remote.patchJson != "null")
                view.setSelection(3, 4); presenter.apply(patch.patchJson)
                check(view.text.toString() == "R" + expected && view.selectionStart == 4 && view.selectionEnd == 5)
                mapOf("text" to view.text.toString(), "selection" to listOf(4, 5), "updateBytes" to update.size, "calls" to calls, "bytes" to bytes)
            }
            checkCase("inputconnection-composition-batch-ownership") {
                val committed = text(read(e)); view.setSelection(view.length())
                val info = EditorInfo(); val connection = requireNotNull(view.onCreateInputConnection(info))
                check(connection.beginBatchEdit()); check(connection.setComposingText("仮", 1))
                check(view.text.toString() == committed + "仮")
                check(BaseInputConnection.getComposingSpanStart(view.editableText) == committed.length)
                check(text(read(e)) == committed)
                batch(r, listOf(insert(r, 0, "Q")))
                val patch = e.applyUpdate(read(r)["identity"].toString(), r.encodeUpdate(e.stateVector())); presenter.apply(patch.patchJson)
                check(presenter.pending != null && view.text.toString() == committed + "仮")
                check(connection.finishComposingText())
                check(BaseInputConnection.getComposingSpanStart(view.editableText) == -1)
                val end = connection.endBatchEdit()
                presenter.cancelAndFlush(committed)
                check(presenter.pending == null && view.text.toString() == "Q" + committed && text(read(e)) == view.text.toString())
                mapOf("connection" to connection.javaClass.name, "composingStart" to committed.length, "remoteQueued" to true,
                    "endBatchReturn" to end, "selectionAfterCancelFlush" to view.selectionStart,
                    "gap" to "explicit cancel and flush; actual keyboard IME, merge/commit, autocorrect and dictation unqualified")
            }
            checkCase("custom-mark-native-span") {
                val span = BackgroundColorSpan(Color.YELLOW)
                view.editableText.setSpan(span, 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                check(view.editableText.getSpans(0, 1, BackgroundColorSpan::class.java).single() === span)
                check(view.editableText.getSpanStart(span) == 0 && span.backgroundColor == Color.YELLOW)
                mapOf("supported" to true, "scope" to "data-only custom review mark presenter; semantic mark import/persistence unqualified")
            }
            checkCase("inline-native-attachment") {
                val committed = text(read(e)); val start = view.length()
                val drawable = ColorDrawable(Color.BLUE).apply { setBounds(0, 0, 18, 18) }
                val attachment = ImageSpan(drawable, ImageSpan.ALIGN_BASELINE)
                view.editableText.append("\uFFFC"); view.editableText.setSpan(attachment, start, start + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                check(view.editableText.getSpans(start, start + 1, ImageSpan::class.java).single() === attachment)
                check(view.text.last() == '\uFFFC' && text(read(e)) == committed)
                view.editableText.delete(start, start + 1)
                check(view.editableText.getSpans(0, view.length(), ImageSpan::class.java).isEmpty())
                mapOf("supported" to true, "size" to listOf(18, 18), "scope" to "native presenter only; semantic attachments, accessibility and asset lifecycle unqualified")
            }
            checkCase("observed-copies-disposal") {
                check(presenter.copies.size == 3 && presenter.copies.all { (it["replacementUtf16"] as Int) > 0 })
                val owned = e.checkpoint(); e.dispose(); r.dispose(); e.close(); r.close()
                check(owned.bytes.isNotEmpty() && e.uniffiIsDestroyed && r.uniffiIsDestroyed)
                mapOf("controlCopies" to presenter.copies, "scope" to "observed generated and control copy sites, excludes JNA/Rust internals and timing", "explicitClose" to true)
            }
        } catch (e: Throwable) { results += mapOf("id" to "setup", "passed" to false, "error" to e.stackTraceToString()) }
        finally {
            for (e in listOfNotNull(engine, peer)) if (!e.uniffiIsDestroyed) { e.dispose(); e.close() }
        }
        if (results.isEmpty()) results += mapOf("id" to "zero-match", "passed" to false)
        val failed = results.count { it["passed"] == false }
        val report = mapOf("cases" to results, "counts" to mapOf("executed" to results.size, "passed" to results.size - failed, "failed" to failed, "skipped" to 0),
            "platform" to mapOf("sdk" to android.os.Build.VERSION.SDK_INT, "release" to android.os.Build.VERSION.RELEASE, "abis" to android.os.Build.SUPPORTED_ABIS.toList()),
            "qualification" to "actual emulator control preparation; physical device, real IME, SDK parity, performance and release unqualified")
        File(filesDir, "result.json").writeText(json(report))
    }
}
