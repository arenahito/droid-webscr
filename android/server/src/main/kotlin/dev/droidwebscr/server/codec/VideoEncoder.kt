package dev.droidwebscr.server.codec

import dev.droidwebscr.server.protocol.Frame
import dev.droidwebscr.server.protocol.FrameHeader
import dev.droidwebscr.server.protocol.MessageType
import dev.droidwebscr.server.protocol.StreamId
import java.nio.ByteBuffer
import java.nio.ByteOrder

interface VideoEncoder {
    fun start(config: VideoEncoderConfig)
    fun inputSurface(): Any
    fun dequeueOutput(timeoutUs: Long = 10_000): EncodedVideoPacket?
    fun requestKeyFrame()
    fun reconfigure(config: VideoEncoderConfig)
    fun stop()
}

data class EncodedVideoPacket(
    val bytes: ByteArray,
    val codecConfig: Boolean,
    val keyFrame: Boolean,
    val timestampUs: ULong,
)

data class VideoEncoderConfig(
    val width: Int,
    val height: Int,
    val bitrate: Int,
    val fps: Int,
) {
    fun validated(): VideoEncoderConfig {
        require(width >= 64) { "Video width must be at least 64 pixels." }
        require(height >= 64) { "Video height must be at least 64 pixels." }
        require(bitrate > 0) { "Video bitrate must be positive." }
        require(fps > 0) { "Video fps must be positive." }
        return copy(
            width = width.roundDownToEven(),
            height = height.roundDownToEven(),
            fps = fps.coerceAtMost(60),
        )
    }
}

object VideoProtocol {
    const val FLAG_KEY_FRAME: UShort = 1u
    private const val CODEC_AVC: Byte = 1

    fun createVideoConfigFrame(
        config: VideoEncoderConfig,
        codecConfig: ByteArray,
        sequence: ULong,
    ): Frame {
        val validated = config.validated()
        val payload = ByteBuffer
            .allocate(16 + codecConfig.size)
            .order(ByteOrder.BIG_ENDIAN)
            .put(CODEC_AVC)
            .put(1)
            .putShort(0)
            .putInt(validated.width)
            .putInt(validated.height)
            .putInt(codecConfig.size)
            .put(codecConfig)
            .array()
        return Frame(
            FrameHeader(
                type = MessageType.VIDEO_CONFIG.value,
                streamId = StreamId.Video.value,
                payloadLength = payload.size.toUInt(),
                sequence = sequence,
            ),
            payload,
        )
    }

    fun createVideoFrame(
        accessUnit: ByteArray,
        keyFrame: Boolean,
        timestampUs: ULong,
        sequence: ULong,
    ): Frame = Frame(
        FrameHeader(
            type = MessageType.VIDEO_FRAME.value,
            flags = if (keyFrame) FLAG_KEY_FRAME else 0u,
            streamId = StreamId.Video.value,
            payloadLength = accessUnit.size.toUInt(),
            timestampUs = timestampUs,
            sequence = sequence,
        ),
        accessUnit,
    )
}

private fun Int.roundDownToEven(): Int = if (this % 2 == 0) this else this - 1
