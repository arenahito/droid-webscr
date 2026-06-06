package dev.droidwebscr.server.codec

interface VideoEncoder {
    fun start(config: VideoEncoderConfig)
    fun requestKeyFrame()
    fun reconfigure(config: VideoEncoderConfig)
    fun stop()
}

data class VideoEncoderConfig(
    val width: Int,
    val height: Int,
    val bitrate: Int,
    val fps: Int,
)
