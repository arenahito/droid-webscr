package dev.droidwebscr.server.session

import dev.droidwebscr.server.codec.VideoEncoderConfig
import dev.droidwebscr.server.input.InputDisplayBounds
import dev.droidwebscr.server.input.InputInjector
import dev.droidwebscr.server.input.KeyAction
import dev.droidwebscr.server.input.KeyControlMessage
import dev.droidwebscr.server.input.PointerAction
import dev.droidwebscr.server.input.PointerControlMessage
import dev.droidwebscr.server.input.SystemAction
import dev.droidwebscr.server.protocol.Frame
import dev.droidwebscr.server.protocol.MessageType
import dev.droidwebscr.server.protocol.StreamId
import java.nio.ByteBuffer
import java.nio.ByteOrder

internal class ControlFrameDispatcher(
    private val bounds: InputDisplayBounds,
    private val inputInjector: InputInjector,
    private val reconfigureVideo: (VideoEncoderConfig) -> Unit,
) {
    fun dispatch(frame: Frame): String = when (frame.header.type) {
        MessageType.CONTROL_POINTER.value -> {
            requireControlStream(frame)
            "control:pointer:${inputInjector.injectPointer(parsePointer(frame))}"
        }
        MessageType.CONTROL_KEY.value -> {
            requireControlStream(frame)
            "control:key:${inputInjector.injectKey(parseKey(frame))}"
        }
        MessageType.CONTROL_TEXT.value -> {
            requireControlStream(frame)
            "control:text:${inputInjector.injectText(frame.payload.decodeToString())}"
        }
        MessageType.CONTROL_SYSTEM.value -> {
            requireControlStream(frame)
            val action = parseSystemAction(frame)
            "control:${action.name.lowercase()}:${inputInjector.injectSystemAction(action)}"
        }
        MessageType.CONTROL_CLIPBOARD.value -> {
            requireControlStream(frame)
            val action = parseClipboardAction(frame)
            "clipboard:$action:Rejected(Clipboard sync is disabled by policy.)"
        }
        MessageType.VIDEO_RECONFIGURE.value -> {
            require(frame.header.streamId == StreamId.Video.value) {
                "VIDEO_RECONFIGURE must use the video stream."
            }
            val nextConfig = parseVideoReconfigure(frame)
            reconfigureVideo(nextConfig)
            "video:reconfigure:Accepted"
        }
        else -> throw IllegalArgumentException("Unsupported message type ${frame.header.type}.")
    }

    private fun parsePointer(frame: Frame): PointerControlMessage {
        require(frame.payload.size == 20) { "CONTROL_POINTER payload must be 20 bytes." }
        val buffer = frame.payloadBuffer()
        val action = when (buffer.get(0).toInt()) {
            0 -> PointerAction.Down
            1 -> PointerAction.Move
            2 -> PointerAction.Up
            3 -> PointerAction.Cancel
            else -> throw IllegalArgumentException("Unsupported pointer action ${buffer.get(0).toInt()}.")
        }
        return PointerControlMessage(
            action = action,
            pointerId = buffer.getShort(2).toInt() and 0xffff,
            x = buffer.getInt(4),
            y = buffer.getInt(8),
            pressure = (buffer.get(12).toInt() and 0xff) / 255f,
            buttons = buffer.getShort(14).toInt() and 0xffff,
            displayId = buffer.getInt(16),
        ).validated(bounds)
    }

    private fun parseKey(frame: Frame): KeyControlMessage {
        require(frame.payload.size == 12) { "CONTROL_KEY payload must be 12 bytes." }
        val buffer = frame.payloadBuffer()
        val action = when (buffer.get(0).toInt()) {
            0 -> KeyAction.Down
            1 -> KeyAction.Up
            else -> throw IllegalArgumentException("Unsupported key action ${buffer.get(0).toInt()}.")
        }
        return KeyControlMessage(
            action = action,
            keyCode = buffer.getShort(2).toInt() and 0xffff,
            metaState = buffer.getInt(4),
            repeat = buffer.getInt(8),
        ).validated()
    }

    private fun parseSystemAction(frame: Frame): SystemAction {
        require(frame.payload.size == 1) { "CONTROL_SYSTEM payload must contain exactly one action byte." }
        return when (frame.payload[0].toInt()) {
            0 -> SystemAction.Back
            1 -> SystemAction.Home
            2 -> SystemAction.Overview
            3 -> SystemAction.VolumeUp
            4 -> SystemAction.VolumeDown
            5 -> SystemAction.Power
            6 -> SystemAction.Keyboard
            else -> throw IllegalArgumentException("Unsupported CONTROL_SYSTEM action ${frame.payload[0].toInt()}.")
        }
    }

    private fun parseClipboardAction(frame: Frame): String {
        require(frame.payload.isNotEmpty()) { "CONTROL_CLIPBOARD payload must contain an action byte." }
        return when (frame.payload[0].toInt()) {
            0 -> "set"
            1 -> "get"
            else -> throw IllegalArgumentException("Unsupported clipboard action ${frame.payload[0].toInt()}.")
        }
    }

    private fun parseVideoReconfigure(frame: Frame): VideoEncoderConfig {
        require(frame.payload.size == 8) { "VIDEO_RECONFIGURE payload must be 8 bytes." }
        val buffer = frame.payloadBuffer()
        val bitrateMbps = buffer.getInt(0)
        val fps = buffer.getInt(4)
        return VideoEncoderConfig(
            width = bounds.width,
            height = bounds.height,
            bitrate = bitrateMbps * 1_000_000,
            fps = fps,
        ).validated()
    }

    private fun requireControlStream(frame: Frame) {
        require(frame.header.streamId == StreamId.Control.value) {
            "Control frame must use the control stream."
        }
    }

    private fun Frame.payloadBuffer(): ByteBuffer = ByteBuffer.wrap(payload).order(ByteOrder.BIG_ENDIAN)
}
