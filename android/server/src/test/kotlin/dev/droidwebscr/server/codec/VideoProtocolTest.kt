package dev.droidwebscr.server.codec

import dev.droidwebscr.server.protocol.MessageType
import dev.droidwebscr.server.protocol.StreamId
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

class VideoProtocolTest {
    @Test
    fun `creates video config frame with binary metadata and codec config bytes`() {
        val frame = VideoProtocol.createVideoConfigFrame(
            config = VideoEncoderConfig(width = 1080, height = 2400, bitrate = 4_000_000, fps = 30),
            codecConfig = byteArrayOf(1, 2, 3),
            sequence = 4u,
        )

        assertEquals(MessageType.VIDEO_CONFIG.value, frame.header.type)
        assertEquals(StreamId.Video.value, frame.header.streamId)
        assertEquals(4u, frame.header.sequence)
        assertEquals(19u, frame.header.payloadLength)
        assertEquals(1, frame.payload[0].toInt())
        assertEquals(1, frame.payload[1].toInt())
        assertEquals(0, frame.payload[2].toInt())
        assertEquals(3, frame.payload[15].toInt())
        assertContentEquals(byteArrayOf(1, 2, 3), frame.payload.copyOfRange(16, 19))
    }

    @Test
    fun `creates keyframe video frame with encoded access unit payload`() {
        val accessUnit = byteArrayOf(0, 0, 0, 1, 101)
        val frame = VideoProtocol.createVideoFrame(
            accessUnit = accessUnit,
            keyFrame = true,
            timestampUs = 12_345u,
            sequence = 5u,
        )

        assertEquals(MessageType.VIDEO_FRAME.value, frame.header.type)
        assertEquals(StreamId.Video.value, frame.header.streamId)
        assertEquals(1u, frame.header.flags)
        assertEquals(12_345u, frame.header.timestampUs)
        assertEquals(5u, frame.header.sequence)
        assertContentEquals(accessUnit, frame.payload)
    }
}
