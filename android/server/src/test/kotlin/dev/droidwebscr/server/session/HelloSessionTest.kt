package dev.droidwebscr.server.session

import dev.droidwebscr.server.protocol.Frame
import dev.droidwebscr.server.protocol.FrameCodec
import dev.droidwebscr.server.protocol.FrameHeader
import dev.droidwebscr.server.protocol.MessageType
import dev.droidwebscr.server.protocol.StreamId
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class HelloSessionTest {
    @Test
    fun `responds to SESSION_HELLO with SESSION_HELLO_ACK`() {
        val request = FrameCodec.encode(
            Frame(
                FrameHeader(
                    type = MessageType.SESSION_HELLO.value,
                    streamId = StreamId.Session.value,
                    sequence = 7u,
                ),
                ByteArray(0),
            ),
        )
        val output = ByteArrayOutputStream()

        HelloSession().serve(ByteArrayInputStream(request), output)

        val response = FrameCodec.decode(output.toByteArray())
        assertEquals(MessageType.SESSION_HELLO_ACK.value, response.header.type)
        assertEquals(StreamId.Session.value, response.header.streamId)
        assertEquals(7u, response.header.sequence)
        assertEquals(0u, response.header.payloadLength)
    }

    @Test
    fun `rejects payload lengths above the session read limit before allocation`() {
        val request = FrameCodec.encode(
            Frame(
                FrameHeader(type = MessageType.SESSION_HELLO.value),
                ByteArray(0),
            ),
        )
        request[16] = 1
        request[19] = 1

        assertFailsWith<IllegalArgumentException> {
            HelloSession().serve(ByteArrayInputStream(request), ByteArrayOutputStream())
        }
    }
}
