package dev.droidwebscr.server.session

import dev.droidwebscr.server.codec.EncodedVideoPacket
import dev.droidwebscr.server.codec.VideoEncoder
import dev.droidwebscr.server.codec.VideoEncoderConfig
import dev.droidwebscr.server.protocol.Frame
import dev.droidwebscr.server.protocol.FrameCodec
import dev.droidwebscr.server.protocol.FrameHeader
import dev.droidwebscr.server.protocol.MessageType
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingQueue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class VideoStreamPumpTest {
    @Test
    fun `continues writing video frames after the first rendered frame`() {
        val encoder = QueueVideoEncoder()
        val output = ByteArrayOutputStream()
        val writer = SessionFrameWriter(output)
        val pump = VideoStreamPump(
            encoder = encoder,
            initialConfig = VideoEncoderConfig(width = 720, height = 1280, bitrate = 2_000_000, fps = 30),
            writeFrame = writer::writeFrame,
        )

        pump.start()
        encoder.enqueueConfig()
        encoder.enqueueFrame(timestampUs = 1u)
        assertTrue(pump.awaitFirstFrame(timeoutMs = 1_000))
        encoder.enqueueFrame(timestampUs = 2u)
        encoder.enqueueFrame(timestampUs = 3u)
        waitUntil(timeoutMs = 1_000) { decodeAllFrames(output.toByteArray()).size >= 4 }
        pump.stop()

        assertEquals(
            listOf(
                MessageType.VIDEO_CONFIG.value,
                MessageType.VIDEO_FRAME.value,
                MessageType.VIDEO_FRAME.value,
                MessageType.VIDEO_FRAME.value,
            ),
            decodeAllFrames(output.toByteArray()).map { it.header.type },
        )
    }

    private class QueueVideoEncoder : VideoEncoder {
        private val packets = LinkedBlockingQueue<EncodedVideoPacket>()

        fun enqueueConfig() {
            packets.put(
                EncodedVideoPacket(
                    bytes = byteArrayOf(0, 0, 0, 1, 0x67),
                    codecConfig = true,
                    keyFrame = false,
                    timestampUs = 0u,
                ),
            )
        }

        fun enqueueFrame(timestampUs: ULong) {
            packets.put(
                EncodedVideoPacket(
                    bytes = byteArrayOf(0, 0, 0, 1, 0x65),
                    codecConfig = false,
                    keyFrame = true,
                    timestampUs = timestampUs,
                ),
            )
        }

        override fun start(config: VideoEncoderConfig) = Unit
        override fun inputSurface(): Any = Any()
        override fun dequeueOutput(timeoutUs: Long): EncodedVideoPacket? = packets.poll()
        override fun requestKeyFrame() = Unit
        override fun reconfigure(config: VideoEncoderConfig) = Unit
        override fun stop() = Unit
    }
}

private fun decodeAllFrames(bytes: ByteArray): List<Frame> {
    val frames = mutableListOf<Frame>()
    var offset = 0
    while (offset < bytes.size) {
        val header = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        val payloadLength = header.getInt(offset + 16)
        val length = FrameHeader.HEADER_LENGTH_BYTES + payloadLength
        frames += FrameCodec.decode(bytes.copyOfRange(offset, offset + length))
        offset += length
    }
    return frames
}

private fun waitUntil(timeoutMs: Long, predicate: () -> Boolean) {
    val deadline = System.nanoTime() + timeoutMs * 1_000_000L
    while (System.nanoTime() < deadline) {
        if (predicate()) {
            return
        }
        Thread.sleep(10)
    }
    error("Condition was not met before timeout.")
}
