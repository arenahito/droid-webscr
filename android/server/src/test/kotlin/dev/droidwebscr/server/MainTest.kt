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
            serveProductVerificationOnce = { throw IllegalStateException("encoder unavailable") },
            runLifecycle = {},
        )

        assertEquals(1, exitCode)
        assertContains(stderrBytes.toString(Charsets.UTF_8), "droid-webscr Android server failed")
        assertContains(stderrBytes.toString(Charsets.UTF_8), "encoder unavailable")
    }
}
