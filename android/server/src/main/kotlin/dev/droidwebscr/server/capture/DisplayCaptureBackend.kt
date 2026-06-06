package dev.droidwebscr.server.capture

interface DisplayCaptureBackend {
    fun start(config: CaptureConfig, inputSurface: Any? = null): CaptureSession
}

data class CaptureConfig(
    val displayId: Int,
    val width: Int,
    val height: Int,
) {
    fun validated(): CaptureConfig {
        require(displayId >= 0) { "Display id must be non-negative." }
        require(width >= 64) { "Capture width must be at least 64 pixels." }
        require(height >= 64) { "Capture height must be at least 64 pixels." }
        return copy(width = width.roundDownToEven(), height = height.roundDownToEven())
    }
}

fun interface CaptureSession {
    fun stop()
}

class DiagnosticFrameBackend(
    private val recordEvent: (String) -> Unit = {},
) : DisplayCaptureBackend {
    override fun start(config: CaptureConfig, inputSurface: Any?): CaptureSession {
        val validated = config.validated()
        recordEvent("diagnostic:start:${validated.width}x${validated.height}")
        return CaptureSession { recordEvent("diagnostic:stop") }
    }
}

fun interface ShellDisplayCaptureAdapter {
    fun start(config: CaptureConfig, inputSurface: Any): CaptureSession
}

class ShellDisplayCaptureBackend(
    private val adapter: ShellDisplayCaptureAdapter = ReflectionShellDisplayCaptureAdapter(),
) : DisplayCaptureBackend {
    override fun start(config: CaptureConfig, inputSurface: Any?): CaptureSession {
        val validated = config.validated()
        require(inputSurface != null) { "Shell display capture requires an encoder input surface." }
        return try {
            adapter.start(validated, inputSurface)
        } catch (error: UnsupportedOperationException) {
            throw IllegalStateException(error.message, error)
        } catch (error: ReflectiveOperationException) {
            throw IllegalStateException("display surface capture unavailable", error)
        }
    }
}

private fun Int.roundDownToEven(): Int = if (this % 2 == 0) this else this - 1
