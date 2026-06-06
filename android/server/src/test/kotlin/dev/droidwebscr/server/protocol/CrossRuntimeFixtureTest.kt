package dev.droidwebscr.server.protocol

import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals

class CrossRuntimeFixtureTest {
    @Test
    fun `Kotlin encoder is byte-compatible with the shared TypeScript fixture`() {
        val expectedHex = Path.of("../../packages/protocol/test-fixtures/video-frame.hex")
            .normalize()
            .readText()
            .trim()

        val encoded = FrameCodec.encode(
            Frame(
                header = FrameHeader(
                    type = MessageType.VIDEO_FRAME.value,
                    flags = 0x00ffu,
                    streamId = StreamId.Video.value,
                    payloadLength = 4u,
                    timestampUs = 1_717_171_717_171_717u,
                    sequence = 9_007_199_254_740_991u,
                ),
                payload = byteArrayOf(1, 2, 3, 4),
            ),
        )

        assertEquals(expectedHex, encoded.toHex())
    }
}

private fun ByteArray.toHex(): String = joinToString(separator = "") {
    it.toUByte().toString(16).padStart(2, '0')
}
