package dev.droidwebscr.server.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder

object FrameCodec {
    fun encode(frame: Frame): ByteArray {
        val payload = frame.payload
        val buffer = ByteBuffer
            .allocate(FrameHeader.HEADER_LENGTH_BYTES + payload.size)
            .order(ByteOrder.BIG_ENDIAN)

        buffer.putInt(frame.header.magic.toInt())
        buffer.putShort(frame.header.version.toShort())
        buffer.putShort(frame.header.headerLength.toShort())
        buffer.putShort(frame.header.type.toShort())
        buffer.putShort(frame.header.flags.toShort())
        buffer.putInt(frame.header.streamId.toInt())
        buffer.putInt(payload.size)
        buffer.putLong(frame.header.timestampUs.toLong())
        buffer.putLong(frame.header.sequence.toLong())
        buffer.putInt(frame.header.reserved.toInt())
        buffer.put(payload)

        return buffer.array()
    }

    fun decode(bytes: ByteArray, options: DecodeOptions = DecodeOptions()): Frame {
        if (bytes.size < FrameHeader.HEADER_LENGTH_BYTES) {
            throw ProtocolException(
                ProtocolErrorCode.FRAME_TOO_SHORT,
                "Frame is shorter than the protocol header.",
            )
        }

        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        val magic = buffer.int.toUInt()
        if (magic != FrameHeader.MAGIC) {
            throw ProtocolException(ProtocolErrorCode.INVALID_MAGIC, "Frame magic does not match DWSC.")
        }

        val version = buffer.short.toUShort()
        if (version != FrameHeader.WIRE_VERSION) {
            throw ProtocolException(
                ProtocolErrorCode.UNSUPPORTED_VERSION,
                "Unsupported wire version: $version.",
            )
        }

        val headerLength = buffer.short.toUShort()
        if (headerLength != FrameHeader.HEADER_LENGTH) {
            throw ProtocolException(
                ProtocolErrorCode.UNSUPPORTED_HEADER_LENGTH,
                "Unsupported header length: $headerLength.",
            )
        }

        val type = buffer.short.toUShort()
        val flags = buffer.short.toUShort()
        val streamId = buffer.int.toUInt()
        val payloadLength = buffer.int.toUInt()
        if (payloadLength > options.maxPayloadLength) {
            throw ProtocolException(
                ProtocolErrorCode.PAYLOAD_TOO_LARGE,
                "Payload length $payloadLength exceeds limit ${options.maxPayloadLength}.",
            )
        }

        val expectedLength = FrameHeader.HEADER_LENGTH_BYTES + payloadLength.toInt()
        if (bytes.size != expectedLength) {
            throw ProtocolException(
                ProtocolErrorCode.PAYLOAD_LENGTH_MISMATCH,
                "Frame length ${bytes.size} does not match declared length $expectedLength.",
            )
        }

        val timestampUs = buffer.long.toULong()
        val sequence = buffer.long.toULong()
        val reserved = buffer.int.toUInt()
        val payload = ByteArray(payloadLength.toInt())
        buffer.get(payload)

        return Frame(
            header = FrameHeader(
                magic = magic,
                version = version,
                headerLength = headerLength,
                type = type,
                flags = flags,
                streamId = streamId,
                payloadLength = payloadLength,
                timestampUs = timestampUs,
                sequence = sequence,
                reserved = reserved,
            ),
            payload = payload,
        )
    }
}
