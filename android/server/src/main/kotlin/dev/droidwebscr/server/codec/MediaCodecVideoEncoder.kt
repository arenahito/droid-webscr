package dev.droidwebscr.server.codec

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Bundle
import java.nio.ByteBuffer

class MediaCodecVideoEncoder : VideoEncoder {
    private var codec: MediaCodec? = null
    private var surface: Any? = null
    private var currentConfig: VideoEncoderConfig? = null

    override fun start(config: VideoEncoderConfig) {
        val validated = config.validated()
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, validated.width, validated.height)
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        format.setInteger(MediaFormat.KEY_BIT_RATE, validated.bitrate)
        format.setInteger(MediaFormat.KEY_FRAME_RATE, validated.fps)
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)

        val created = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        created.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        surface = created.createInputSurface()
        created.start()
        codec = created
        currentConfig = validated
    }

    override fun inputSurface(): Any =
        surface ?: error("Video encoder has not been started.")

    override fun dequeueOutput(timeoutUs: Long): EncodedVideoPacket? {
        val activeCodec = codec ?: error("Video encoder has not been started.")
        val info = MediaCodec.BufferInfo()
        val index = activeCodec.dequeueOutputBuffer(info, timeoutUs)
        if (index < 0) {
            return null
        }

        val output = activeCodec.getOutputBuffer(index) ?: ByteBuffer.allocate(0)
        val bytes = ByteArray(info.size)
        output.position(info.offset)
        output.limit(info.offset + info.size)
        output.get(bytes)
        val flags = info.flags
        activeCodec.releaseOutputBuffer(index, false)
        if (bytes.isEmpty()) {
            return null
        }

        return EncodedVideoPacket(
            bytes = bytes,
            codecConfig = flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0,
            keyFrame = flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0,
            timestampUs = info.presentationTimeUs.toULong(),
        )
    }

    override fun requestKeyFrame() {
        val activeCodec = codec ?: return
        val params = Bundle()
        params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
        activeCodec.setParameters(params)
    }

    override fun reconfigure(config: VideoEncoderConfig) {
        val activeCodec = codec ?: error("Video encoder has not been started.")
        val current = currentConfig ?: error("Video encoder has not been started.")
        val validated = config.validated()
        require(validated.width == current.width && validated.height == current.height) {
            "Video reconfigure cannot change the active encoder surface size."
        }
        val params = Bundle()
        params.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, validated.bitrate)
        activeCodec.setParameters(params)
        currentConfig = validated
        requestKeyFrame()
    }

    override fun stop() {
        val activeCodec = codec
        codec = null
        surface = null
        currentConfig = null
        if (activeCodec != null) {
            runCatching { activeCodec.stop() }
            runCatching { activeCodec.release() }
        }
    }
}
