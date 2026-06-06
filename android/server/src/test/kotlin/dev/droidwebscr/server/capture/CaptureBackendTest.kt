package dev.droidwebscr.server.capture

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class CaptureBackendTest {
    @Test
    fun `validates capture config`() {
        val config = CaptureConfig(
            displayId = 0,
            width = 1081,
            height = 2401,
            sourceWidth = 1281,
            sourceHeight = 2857,
        ).validated()

        assertEquals(1080, config.width)
        assertEquals(2400, config.height)
        assertEquals(1280, config.sourceWidth)
        assertEquals(2856, config.sourceHeight)
        assertFailsWith<IllegalArgumentException> {
            CaptureConfig(displayId = -1, width = 1080, height = 2400).validated()
        }
    }

    @Test
    fun `diagnostic backend records start and stop order`() {
        val events = mutableListOf<String>()
        val backend = DiagnosticFrameBackend(events::add)
        val session = backend.start(CaptureConfig(displayId = 0, width = 1080, height = 2400))

        session.stop()

        assertEquals(listOf("diagnostic:start:1080x2400", "diagnostic:stop"), events)
    }

    @Test
    fun `shell backend reports unsupported capability from adapter failure`() {
        val backend = ShellDisplayCaptureBackend(
            adapter = object : ShellDisplayCaptureAdapter {
                override fun start(config: CaptureConfig, inputSurface: Any): CaptureSession {
                    throw UnsupportedOperationException("display surface capture unavailable")
                }
            },
        )

        val failure = assertFailsWith<IllegalStateException> {
            backend.start(CaptureConfig(displayId = 0, width = 1080, height = 2400), Any())
        }
        assertEquals("display surface capture unavailable", failure.message)
    }
}
