package dev.droidwebscr.server.protocol

enum class MessageType(val value: UShort) {
    SESSION_HELLO(0x0001u),
    SESSION_HELLO_ACK(0x0002u),
    SESSION_START(0x0003u),
    SESSION_STOP(0x0004u),
    SESSION_ERROR(0x0005u),
    DEVICE_INFO(0x0101u),
    DEVICE_ROTATION(0x0102u),
    VIDEO_CONFIG(0x0201u),
    VIDEO_FRAME(0x0202u),
    VIDEO_RECONFIGURE(0x0203u),
    CONTROL_POINTER(0x0301u),
    CONTROL_KEY(0x0302u),
    CONTROL_TEXT(0x0303u),
    CONTROL_SYSTEM(0x0304u),
    CONTROL_CLIPBOARD(0x0305u),
    LOG_RECORD(0x0401u),
}

enum class StreamId(val value: UInt) {
    Session(1u),
    Device(2u),
    Video(3u),
    Control(4u),
    Log(5u),
}

enum class ProtocolErrorCode {
    FRAME_TOO_SHORT,
    INVALID_MAGIC,
    UNSUPPORTED_VERSION,
    UNSUPPORTED_HEADER_LENGTH,
    PAYLOAD_LENGTH_MISMATCH,
    PAYLOAD_TOO_LARGE,
}

class ProtocolException(
    val code: ProtocolErrorCode,
    message: String,
) : IllegalArgumentException(message)
