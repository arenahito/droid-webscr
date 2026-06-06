package dev.droidwebscr.server.protocol

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class FrameCodecTest {
    @Test
    fun `encodes and decodes a 40 byte big endian frame header`() {
        val header = FrameHeader(
            type = MessageType.VIDEO_FRAME.value,
            flags = 0x00ffu,
            streamId = StreamId.Video.value,
            payloadLength = 4u,
            timestampUs = 1_717_171_717_171_717u,
            sequence = 9_007_199_254_740_991u,
        )
        val payload = byteArrayOf(1, 2, 3, 4)

        val encoded = FrameCodec.encode(Frame(header, payload))
        val decoded = FrameCodec.decode(encoded)

        assertEquals(40 + payload.size, encoded.size)
        assertEquals(FrameHeader.MAGIC, decoded.header.magic)
        assertEquals(1u, decoded.header.version)
        assertEquals(40u, decoded.header.headerLength)
        assertEquals(MessageType.VIDEO_FRAME.value, decoded.header.type)
        assertEquals(0x00ffu, decoded.header.flags)
        assertEquals(StreamId.Video.value, decoded.header.streamId)
        assertEquals(4u, decoded.header.payloadLength)
        assertEquals(1_717_171_717_171_717u, decoded.header.timestampUs)
        assertEquals(9_007_199_254_740_991u, decoded.header.sequence)
        assertEquals(0u, decoded.header.reserved)
        assertContentEquals(payload, decoded.payload)
    }

    @Test
    fun `rejects invalid magic and unsupported header length`() {
        val valid = FrameCodec.encode(
            Frame(
                FrameHeader(type = MessageType.SESSION_HELLO.value),
                ByteArray(0),
            ),
        )

        val invalidMagic = valid.copyOf()
        invalidMagic[3] = 0
        assertEquals(
            ProtocolErrorCode.INVALID_MAGIC,
            assertFailsWith<ProtocolException> { FrameCodec.decode(invalidMagic) }.code,
        )

        val invalidHeaderLength = valid.copyOf()
        invalidHeaderLength[7] = 32
        assertEquals(
            ProtocolErrorCode.UNSUPPORTED_HEADER_LENGTH,
            assertFailsWith<ProtocolException> { FrameCodec.decode(invalidHeaderLength) }.code,
        )
    }

    @Test
    fun `checks payload bounds before slicing`() {
        val encoded = FrameCodec.encode(
            Frame(
                FrameHeader(type = MessageType.VIDEO_CONFIG.value),
                byteArrayOf(1, 2, 3, 4),
            ),
        )

        val tooLargeForOptions = assertFailsWith<ProtocolException> {
            FrameCodec.decode(encoded, DecodeOptions(maxPayloadLength = 3u))
        }
        assertEquals(ProtocolErrorCode.PAYLOAD_TOO_LARGE, tooLargeForOptions.code)

        val mismatchedLength = encoded.copyOf()
        mismatchedLength[19] = 99
        val mismatch = assertFailsWith<ProtocolException> { FrameCodec.decode(mismatchedLength) }
        assertEquals(ProtocolErrorCode.PAYLOAD_LENGTH_MISMATCH, mismatch.code)
    }
}
