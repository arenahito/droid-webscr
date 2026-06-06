package dev.droidwebscr.server.session

import dev.droidwebscr.server.codec.VideoEncoderConfig
import dev.droidwebscr.server.input.InputDisplayBounds
import dev.droidwebscr.server.input.InputInjector
import dev.droidwebscr.server.input.InjectionResult
import dev.droidwebscr.server.input.KeyControlMessage
import dev.droidwebscr.server.input.PointerControlMessage
import dev.droidwebscr.server.input.SystemAction
import dev.droidwebscr.server.protocol.Frame
import dev.droidwebscr.server.protocol.FrameHeader
import dev.droidwebscr.server.protocol.MessageType
import dev.droidwebscr.server.protocol.StreamId
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.test.Test
import kotlin.test.assertEquals

class ControlFrameDispatcherTest {
    @Test
    fun `dispatches pointer key text and system control frames`() {
        val input = RecordingInputInjector()
        val dispatcher = ControlFrameDispatcher(
            bounds = InputDisplayBounds(width = 720, height = 1280),
            inputInjector = input,
            reconfigureVideo = { error("unexpected video reconfigure") },
        )

        assertEquals("control:pointer:Accepted", dispatcher.dispatch(pointerFrame()))
        assertEquals("control:key:Accepted", dispatcher.dispatch(keyFrame()))
        assertEquals("control:text:Accepted", dispatcher.dispatch(textFrame("hello")))
        assertEquals("control:home:Accepted", dispatcher.dispatch(systemFrame(1)))

        assertEquals(
            listOf(
                "pointer:Down:24:48:1.0:1:0",
                "key:Down:66:1:2",
                "text:hello",
                "system:Home",
            ),
            input.events,
        )
    }

    @Test
    fun `handles clipboard policy and video reconfigure frames`() {
        val input = RecordingInputInjector()
        val configs = mutableListOf<VideoEncoderConfig>()
        val dispatcher = ControlFrameDispatcher(
            bounds = InputDisplayBounds(width = 720, height = 1280),
            inputInjector = input,
            reconfigureVideo = { configs.add(it) },
        )

        assertEquals("clipboard:set:Rejected(Clipboard sync is disabled by policy.)", dispatcher.dispatch(clipboardFrame()))
        assertEquals("clipboard:get:Rejected(Clipboard sync is disabled by policy.)", dispatcher.dispatch(clipboardFrame(action = 1)))
        assertEquals("video:reconfigure:Accepted", dispatcher.dispatch(videoReconfigureFrame()))

        assertEquals(VideoEncoderConfig(width = 720, height = 1280, bitrate = 4_000_000, fps = 45), configs.single())
    }

    @Test
    fun `scales encoded pointer coordinates to physical input bounds`() {
        val input = RecordingInputInjector()
        val dispatcher = ControlFrameDispatcher(
            bounds = InputDisplayBounds(width = 860, height = 1920),
            inputBounds = InputDisplayBounds(width = 1280, height = 2856),
            inputInjector = input,
            reconfigureVideo = { error("unexpected video reconfigure") },
        )

        assertEquals("control:pointer:Accepted", dispatcher.dispatch(pointerFrame(x = 430, y = 1600)))

        assertEquals("pointer:Down:640:2380:1.0:1:0", input.events.single())
    }

    private class RecordingInputInjector : InputInjector {
        val events = mutableListOf<String>()

        override fun injectPointer(event: PointerControlMessage): InjectionResult {
            events.add("pointer:${event.action}:${event.x}:${event.y}:${event.pressure}:${event.buttons}:${event.displayId}")
            return InjectionResult.Accepted
        }

        override fun injectKey(event: KeyControlMessage): InjectionResult {
            events.add("key:${event.action}:${event.keyCode}:${event.metaState}:${event.repeat}")
            return InjectionResult.Accepted
        }

        override fun injectText(text: String): InjectionResult {
            events.add("text:$text")
            return InjectionResult.Accepted
        }

        override fun injectSystemAction(action: SystemAction): InjectionResult {
            events.add("system:$action")
            return InjectionResult.Accepted
        }
    }
}

private fun pointerFrame(x: Int = 24, y: Int = 48): Frame {
    val payload = ByteBuffer.allocate(20)
        .order(ByteOrder.BIG_ENDIAN)
        .put(0)
        .put(0)
        .putShort(1)
        .putInt(x)
        .putInt(y)
        .put(255.toByte())
        .put(0)
        .putShort(1)
        .putInt(0)
        .array()
    return controlFrame(MessageType.CONTROL_POINTER, payload)
}

private fun keyFrame(): Frame {
    val payload = ByteBuffer.allocate(12)
        .order(ByteOrder.BIG_ENDIAN)
        .put(0)
        .put(0)
        .putShort(66)
        .putInt(1)
        .putInt(2)
        .array()
    return controlFrame(MessageType.CONTROL_KEY, payload)
}

private fun textFrame(text: String): Frame = controlFrame(MessageType.CONTROL_TEXT, text.encodeToByteArray())

private fun systemFrame(action: Int): Frame = controlFrame(MessageType.CONTROL_SYSTEM, byteArrayOf(action.toByte()))

private fun clipboardFrame(action: Int = 0): Frame =
    controlFrame(MessageType.CONTROL_CLIPBOARD, byteArrayOf(action.toByte()) + "blocked".encodeToByteArray())

private fun videoReconfigureFrame(): Frame {
    val payload = ByteBuffer.allocate(8)
        .order(ByteOrder.BIG_ENDIAN)
        .putInt(4)
        .putInt(45)
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

private fun controlFrame(type: MessageType, payload: ByteArray): Frame = Frame(
    FrameHeader(
        type = type.value,
        streamId = StreamId.Control.value,
        payloadLength = payload.size.toUInt(),
    ),
    payload,
)
