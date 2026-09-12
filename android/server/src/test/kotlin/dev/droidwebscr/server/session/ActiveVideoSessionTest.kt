package dev.droidwebscr.server.session

import dev.droidwebscr.server.capture.CaptureConfig
import dev.droidwebscr.server.capture.CaptureSession
import dev.droidwebscr.server.capture.DisplayCaptureBackend
import dev.droidwebscr.server.codec.EncodedVideoPacket
import dev.droidwebscr.server.codec.VideoEncoder
import dev.droidwebscr.server.codec.VideoEncoderConfig
import dev.droidwebscr.server.input.InputDisplayBounds
import dev.droidwebscr.server.input.InputInjector
import dev.droidwebscr.server.input.InjectionResult
import dev.droidwebscr.server.input.KeyControlMessage
import dev.droidwebscr.server.input.PointerControlMessage
import dev.droidwebscr.server.input.ScrollControlMessage
import dev.droidwebscr.server.input.SystemAction
import dev.droidwebscr.server.protocol.Frame
import dev.droidwebscr.server.protocol.FrameHeader
import dev.droidwebscr.server.protocol.MessageType
import dev.droidwebscr.server.protocol.StreamId
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class ActiveVideoSessionTest {
    @Test
    fun `retains the latest video settings when display size changes`() {
        val fixture = ActiveVideoSessionFixture(framePlans = mutableListOf(true, true))

        try {
            fixture.session.start(PORTRAIT_DISPLAY)
            assertEquals(
                "video:reconfigure:Accepted",
                fixture.session.dispatch(videoReconfigureFrame(bitrateMbps = 12, fps = 30)),
            )

            fixture.session.replaceIfDisplaySizeChanged(LANDSCAPE_DISPLAY)

            assertEquals(
                listOf(4_000_000, 12_000_000),
                fixture.encoder.startedConfigs.map(VideoEncoderConfig::bitrate),
            )
        } finally {
            fixture.session.close()
        }
    }

    @Test
    fun `rolls back a failed replacement and retries without closing the old session twice`() {
        val fixture = ActiveVideoSessionFixture(
            framePlans = mutableListOf(true, false, true),
            firstFrameTimeoutMs = 50,
        )

        try {
            fixture.session.start(PORTRAIT_DISPLAY)

            assertFailsWith<IllegalArgumentException> {
                fixture.session.replaceIfDisplaySizeChanged(LANDSCAPE_DISPLAY)
            }
            fixture.session.replaceIfDisplaySizeChanged(LANDSCAPE_DISPLAY)

            assertEquals(3, fixture.encoder.startedConfigs.size)
            assertEquals(
                listOf(1, 1, 0),
                fixture.captureBackend.sessions.map(RecordingCaptureSession::stopCount),
            )
            assertEquals(2, fixture.encoder.stopCount)
            assertEquals(2, fixture.inputInjectors.size)
            assertEquals(1, fixture.inputInjectors.first().closeCount)
        } finally {
            fixture.session.close()
        }
    }

    @Test
    fun `closes every active resource when stream shutdown is interrupted`() {
        val fixture = ActiveVideoSessionFixture(framePlans = mutableListOf(true))

        try {
            fixture.session.start(PORTRAIT_DISPLAY)
            Thread.currentThread().interrupt()

            fixture.session.close()

            assertTrue(Thread.currentThread().isInterrupted)
            assertEquals(1, fixture.captureBackend.sessions.single().stopCount)
            assertEquals(1, fixture.encoder.stopCount)
            assertEquals(1, fixture.inputInjectors.single().closeCount)
        } finally {
            Thread.interrupted()
            fixture.session.close()
        }
    }

    private class ActiveVideoSessionFixture(
        framePlans: MutableList<Boolean>,
        firstFrameTimeoutMs: Long = 1_000,
    ) {
        val captureBackend = RecordingCaptureBackend()
        val encoder = RecordingVideoEncoder(framePlans)
        val inputInjectors = mutableListOf<RecordingInputInjector>()
        val session = ActiveVideoSession(
            captureBackend = captureBackend,
            encoder = encoder,
            frameWriter = SessionFrameWriter(ByteArrayOutputStream()),
            inputInjectorFactory = {
                RecordingInputInjector().also(inputInjectors::add)
            },
            initialVideoSettings = InitialVideoSettings(bitrateMbps = 4, fps = 30),
            firstFrameTimeoutMs = firstFrameTimeoutMs,
            logInfo = {},
        )
    }

    private class RecordingVideoEncoder(
        private val framePlans: MutableList<Boolean>,
    ) : VideoEncoder {
        private val packets = ConcurrentLinkedQueue<EncodedVideoPacket>()
        val startedConfigs = mutableListOf<VideoEncoderConfig>()
        var stopCount = 0
            private set

        override fun start(config: VideoEncoderConfig) {
            startedConfigs.add(config)
            if (framePlans.removeFirst()) {
                packets.add(videoPacket(codecConfig = true))
                packets.add(videoPacket(codecConfig = false))
            }
        }

        override fun inputSurface(): Any = Any()

        override fun dequeueOutput(timeoutUs: Long): EncodedVideoPacket? = packets.poll()

        override fun requestKeyFrame() = Unit

        override fun reconfigure(config: VideoEncoderConfig) = Unit

        override fun stop() {
            stopCount += 1
        }
    }

    private class RecordingCaptureBackend : DisplayCaptureBackend {
        val sessions = mutableListOf<RecordingCaptureSession>()

        override fun start(config: CaptureConfig, inputSurface: Any?): CaptureSession =
            RecordingCaptureSession().also(sessions::add)
    }

    private class RecordingCaptureSession : CaptureSession {
        var stopCount = 0
            private set

        override fun stop() {
            stopCount += 1
        }
    }

    private class RecordingInputInjector : InputInjector, Closeable {
        var closeCount = 0
            private set

        override fun injectPointer(event: PointerControlMessage): InjectionResult =
            InjectionResult.Accepted

        override fun injectKey(event: KeyControlMessage): InjectionResult =
            InjectionResult.Accepted

        override fun injectScroll(event: ScrollControlMessage): InjectionResult =
            InjectionResult.Accepted

        override fun injectText(text: String): InjectionResult = InjectionResult.Accepted

        override fun injectSystemAction(action: SystemAction): InjectionResult =
            InjectionResult.Accepted

        override fun close() {
            closeCount += 1
        }
    }

    private companion object {
        val PORTRAIT_DISPLAY = DisplaySize(width = 720, height = 1280)
        val LANDSCAPE_DISPLAY = DisplaySize(width = 1280, height = 720)

        fun videoPacket(codecConfig: Boolean): EncodedVideoPacket = EncodedVideoPacket(
            bytes = byteArrayOf(0, 0, 0, 1, if (codecConfig) 0x67 else 0x65),
            codecConfig = codecConfig,
            keyFrame = !codecConfig,
            timestampUs = 1u,
        )

        fun videoReconfigureFrame(bitrateMbps: Int, fps: Int): Frame {
            val payload = ByteBuffer.allocate(8)
                .order(ByteOrder.BIG_ENDIAN)
                .putInt(bitrateMbps)
                .putInt(fps)
                .array()
            return Frame(
                FrameHeader(
                    type = MessageType.VIDEO_RECONFIGURE.value,
                    streamId = StreamId.Video.value,
                    payloadLength = payload.size.toUInt(),
                ),
                payload,
            )
        }
    }
}
