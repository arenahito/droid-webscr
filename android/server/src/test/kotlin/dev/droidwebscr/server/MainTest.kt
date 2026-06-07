package dev.droidwebscr.server

import java.io.ByteArrayOutputStream
import java.io.PrintStream
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals

class MainTest {
    @Test
    fun `prints startup failures to stderr`() {
        val stderrBytes = ByteArrayOutputStream()
        val stderr = PrintStream(stderrBytes, true, Charsets.UTF_8)

        val exitCode = runServerMain(
            args = arrayOf("--verify-once", "droid-webscr"),
            stderr = stderr,
            serveHelloOnce = {},
            serveProductVerificationOnce = { _, _ -> throw IllegalStateException("encoder unavailable") },
            runLifecycle = {},
        )

        assertEquals(1, exitCode)
        assertContains(stderrBytes.toString(Charsets.UTF_8), "droid-webscr Android server failed")
        assertContains(stderrBytes.toString(Charsets.UTF_8), "encoder unavailable")
    }

    @Test
    fun `passes initial video settings to verify server`() {
        var capturedSocketName = ""
        var capturedBitrateMbps = 0
        var capturedFps = 0

        val exitCode = runServerMain(
            args = arrayOf("--verify-once", "droid-webscr", "--bitrate-mbps", "12", "--max-fps", "60"),
            stderr = PrintStream(ByteArrayOutputStream(), true, Charsets.UTF_8),
            serveHelloOnce = {},
            serveProductVerificationOnce = { socketName, videoSettings ->
                capturedSocketName = socketName
                capturedBitrateMbps = videoSettings.bitrateMbps
                capturedFps = videoSettings.fps
            },
            runLifecycle = {},
        )

        assertEquals(0, exitCode)
        assertEquals("droid-webscr", capturedSocketName)
        assertEquals(12, capturedBitrateMbps)
        assertEquals(60, capturedFps)
    }
}
