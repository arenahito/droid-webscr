package dev.droidwebscr.server.protocol

data class FrameHeader(
    val magic: UInt = MAGIC,
    val version: UShort = WIRE_VERSION,
    val headerLength: UShort = HEADER_LENGTH,
    val type: UShort,
    val flags: UShort = 0u,
    val streamId: UInt = StreamId.Session.value,
    val payloadLength: UInt = 0u,
    val timestampUs: ULong = 0u,
    val sequence: ULong = 0u,
    val reserved: UInt = 0u,
) {
    companion object {
        const val HEADER_LENGTH_BYTES: Int = 40
        val MAGIC: UInt = 0x44575343u
        val WIRE_VERSION: UShort = 1u
        val HEADER_LENGTH: UShort = HEADER_LENGTH_BYTES.toUShort()
    }
}

data class Frame(
    val header: FrameHeader,
    val payload: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Frame) return false
        return header == other.header && payload.contentEquals(other.payload)
    }

    override fun hashCode(): Int {
        return 31 * header.hashCode() + payload.contentHashCode()
    }
}

data class DecodeOptions(
    val maxPayloadLength: UInt = 16u * 1024u * 1024u,
)
