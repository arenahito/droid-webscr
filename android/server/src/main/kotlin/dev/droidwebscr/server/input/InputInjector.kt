package dev.droidwebscr.server.input

import java.io.Closeable

interface InputInjector {
    fun injectPointer(event: PointerControlMessage): InjectionResult
    fun injectKey(event: KeyControlMessage): InjectionResult
    fun injectText(text: String): InjectionResult
    fun injectSystemAction(action: SystemAction): InjectionResult
}

data class InputDisplayBounds(
    val width: Int,
    val height: Int,
    val maxPointers: Int = 10,
) {
    init {
        require(width > 0) { "Display width must be positive." }
        require(height > 0) { "Display height must be positive." }
        require(maxPointers > 0) { "Max pointers must be positive." }
    }
}

enum class PointerAction(val wireValue: Int) {
    Down(0),
    Move(1),
    Up(2),
    Cancel(3),
}

data class PointerControlMessage(
    val action: PointerAction,
    val pointerId: Int,
    val x: Int,
    val y: Int,
    val pressure: Float = 1f,
    val buttons: Int = 0,
    val displayId: Int = 0,
) {
    fun validated(bounds: InputDisplayBounds): PointerControlMessage {
        require(pointerId in 0 until bounds.maxPointers) { "Pointer id is out of range." }
        require(x in 0 until bounds.width) { "Pointer x is outside the display bounds." }
        require(y in 0 until bounds.height) { "Pointer y is outside the display bounds." }
        require(pressure in 0f..1f) { "Pointer pressure must be between 0 and 1." }
        require(buttons >= 0) { "Pointer buttons must be non-negative." }
        require(displayId >= 0) { "Display id must be non-negative." }
        return this
    }
}

enum class KeyAction(val wireValue: Int) {
    Down(0),
    Up(1),
}

data class KeyControlMessage(
    val action: KeyAction,
    val keyCode: Int,
    val metaState: Int,
    val repeat: Int,
) {
    fun validated(): KeyControlMessage {
        require(keyCode in 1..288) { "Android keycode is outside the supported range." }
        require(metaState >= 0) { "Meta state must be non-negative." }
        require(repeat >= 0) { "Repeat must be non-negative." }
        return this
    }
}

data class TextControlMessage(
    val text: String,
) {
    fun validated(): TextControlMessage {
        require(text.encodeToByteArray().size <= 1024) { "Text payload exceeds 1024 bytes." }
        return this
    }
}

enum class SystemAction {
    Back,
    Home,
    Overview,
    VolumeUp,
    VolumeDown,
    Power,
    Keyboard;

    companion object {
        fun requireSupported(value: String): SystemAction = when (value.lowercase()) {
            "back" -> Back
            "home" -> Home
            "overview" -> Overview
            "volume-up" -> VolumeUp
            "volume-down" -> VolumeDown
            "power" -> Power
            "keyboard" -> Keyboard
            else -> throw IllegalArgumentException("Unsupported system action: $value.")
        }
    }
}

sealed interface InjectionResult {
    data object Accepted : InjectionResult
    data class Rejected(val reason: String) : InjectionResult
}

interface InputEventAdapter : Closeable {
    fun injectKey(event: KeyControlMessage): Boolean
    fun injectPointer(event: PointerControlMessage): Boolean
    fun injectText(text: String): Boolean
    override fun close() = Unit
}

class ShellInputInjector(
    adapter: InputEventAdapter? = null,
    private val displayBounds: InputDisplayBounds,
) : InputInjector, Closeable {
    private val adapter = adapter ?: HybridInputEventAdapter.createDefault(displayBounds)

    override fun injectPointer(event: PointerControlMessage): InjectionResult =
        runCatching { adapter.injectPointer(event.validated(displayBounds)) }
            .toInjectionResult("Pointer event")

    override fun injectKey(event: KeyControlMessage): InjectionResult =
        runCatching { adapter.injectKey(event.validated()) }
            .toInjectionResult("Key event")

    override fun injectText(text: String): InjectionResult {
        val message = TextControlMessage(text).validated()
        return runCatching { adapter.injectText(message.text) }
            .toInjectionResult("Text event")
    }

    override fun injectSystemAction(action: SystemAction): InjectionResult {
        val keyCode = when (action) {
            SystemAction.Back -> KEYCODE_BACK
            SystemAction.Home -> KEYCODE_HOME
            SystemAction.Overview -> KEYCODE_APP_SWITCH
            SystemAction.VolumeUp -> KEYCODE_VOLUME_UP
            SystemAction.VolumeDown -> KEYCODE_VOLUME_DOWN
            SystemAction.Power -> KEYCODE_POWER
            SystemAction.Keyboard -> KEYCODE_MENU
        }
        return runCatching {
            val downAccepted = adapter.injectKey(KeyControlMessage(KeyAction.Down, keyCode, 0, 0))
            val upAccepted = adapter.injectKey(KeyControlMessage(KeyAction.Up, keyCode, 0, 0))
            downAccepted && upAccepted
        }
            .toInjectionResult("System action")
    }

    override fun close() {
        adapter.close()
    }

    private fun Result<Boolean>.toInjectionResult(label: String): InjectionResult =
        fold(
            onSuccess = { accepted ->
                if (accepted) {
                    InjectionResult.Accepted
                } else {
                    InjectionResult.Rejected("$label was rejected by the input adapter.")
                }
            },
            onFailure = { error -> InjectionResult.Rejected("$label failed: ${error.message}") },
        )

    private companion object {
        const val KEYCODE_BACK = 4
        const val KEYCODE_HOME = 3
        const val KEYCODE_APP_SWITCH = 187
        const val KEYCODE_VOLUME_UP = 24
        const val KEYCODE_VOLUME_DOWN = 25
        const val KEYCODE_POWER = 26
        const val KEYCODE_MENU = 82
    }
}
