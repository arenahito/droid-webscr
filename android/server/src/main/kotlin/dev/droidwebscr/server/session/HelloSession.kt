package dev.droidwebscr.server.session

import dev.droidwebscr.server.protocol.Frame
import dev.droidwebscr.server.protocol.FrameCodec
import dev.droidwebscr.server.protocol.FrameHeader
import dev.droidwebscr.server.protocol.FrameHeader.Companion.HEADER_LENGTH_BYTES
import dev.droidwebscr.server.protocol.MessageType
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

class HelloSession {
    private val maxPayloadLength = 16 * 1024 * 1024

    fun serve(input: InputStream, output: OutputStream) {
        val request = FrameCodec.decode(readFrameBytes(input))
        require(request.header.type == MessageType.SESSION_HELLO.value) {
            "Expected SESSION_HELLO, received message type ${request.header.type}."
        }

        val response = FrameCodec.encode(
            Frame(
                FrameHeader(
                    type = MessageType.SESSION_HELLO_ACK.value,
                    streamId = request.header.streamId,
                    sequence = request.header.sequence,
                ),
                ByteArray(0),
            ),
        )
        output.write(response)
        output.flush()
    }

    private fun readFrameBytes(input: InputStream): ByteArray {
        val header = ByteArray(HEADER_LENGTH_BYTES)
        readFully(input, header)
        val payloadLength = ByteBuffer
            .wrap(header)
            .order(ByteOrder.BIG_ENDIAN)
            .getInt(16)
        require(payloadLength >= 0) { "Payload length must be non-negative." }
        require(payloadLength <= maxPayloadLength) {
            "Payload length $payloadLength exceeds limit $maxPayloadLength."
        }

        val frame = ByteArray(HEADER_LENGTH_BYTES + payloadLength)
        header.copyInto(frame)
        if (payloadLength > 0) {
            readFully(input, frame, HEADER_LENGTH_BYTES, payloadLength)
        }
        return frame
    }

    private fun readFully(input: InputStream, buffer: ByteArray) {
        readFully(input, buffer, 0, buffer.size)
    }

    private fun readFully(input: InputStream, buffer: ByteArray, offset: Int, length: Int) {
        var read = 0
        while (read < length) {
            val count = input.read(buffer, offset + read, length - read)
            if (count < 0) {
                throw EOFException("Input ended before a complete protocol frame was received.")
            }
            read += count
        }
    }
}
