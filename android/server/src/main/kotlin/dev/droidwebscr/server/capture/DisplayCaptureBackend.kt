package dev.droidwebscr.server.capture

interface DisplayCaptureBackend {
    fun start(config: CaptureConfig): CaptureSession
}

data class CaptureConfig(
    val displayId: Int,
    val width: Int,
    val height: Int,
)

interface CaptureSession {
    fun stop()
}
