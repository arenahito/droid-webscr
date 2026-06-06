package dev.droidwebscr.server.codec

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class VideoEncoderConfigTest {
    @Test
    fun `validates and normalizes encoder config`() {
        val config = VideoEncoderConfig(
            width = 1081,
            height = 2401,
            bitrate = 4_000_000,
            fps = 61,
        ).validated()

        assertEquals(1080, config.width)
        assertEquals(2400, config.height)
        assertEquals(4_000_000, config.bitrate)
        assertEquals(60, config.fps)
    }

    @Test
    fun `rejects invalid encoder config`() {
        assertFailsWith<IllegalArgumentException> {
            VideoEncoderConfig(width = 16, height = 2400, bitrate = 4_000_000, fps = 30).validated()
        }
        assertFailsWith<IllegalArgumentException> {
            VideoEncoderConfig(width = 1080, height = 2400, bitrate = 0, fps = 30).validated()
        }
        assertFailsWith<IllegalArgumentException> {
            VideoEncoderConfig(width = 1080, height = 2400, bitrate = 4_000_000, fps = 0).validated()
        }
    }
}
