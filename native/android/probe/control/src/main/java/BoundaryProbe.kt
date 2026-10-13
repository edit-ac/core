// Instrumented generated binding calls remain serial on the Activity main thread.
object BoundaryProbe {
    val events = linkedMapOf<String, Int>()
    val bytes = linkedMapOf<String, Int>()
    fun record(key: String, size: Int = 0) {
        events[key] = (events[key] ?: 0) + 1
        bytes[key] = (bytes[key] ?: 0) + size
    }
    fun reset() { events.clear(); bytes.clear() }
}
