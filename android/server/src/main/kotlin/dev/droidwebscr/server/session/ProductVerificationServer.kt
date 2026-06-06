package dev.droidwebscr.server.session

import android.net.LocalServerSocket
import dev.droidwebscr.server.capture.CaptureConfig
import dev.droidwebscr.server.capture.DisplayCaptureBackend
import dev.droidwebscr.server.capture.ShellDisplayCaptureBackend
import dev.droidwebscr.server.codec.MediaCodecVideoEncoder
import dev.droidwebscr.server.codec.VideoEncoder
import dev.droidwebscr.server.codec.VideoEncoderConfig
import dev.droidwebscr.server.codec.VideoProtocol
import dev.droidwebscr.server.input.InputDisplayBounds
import dev.droidwebscr.server.input.InputInjector
import dev.droidwebscr.server.input.ShellInputInjector
import dev.droidwebscr.server.input.SystemAction
import dev.droidwebscr.server.protocol.Frame
import dev.droidwebscr.server.protocol.FrameCodec
import dev.droidwebscr.server.protocol.FrameHeader
import dev.droidwebscr.server.protocol.FrameHeader.Companion.HEADER_LENGTH_BYTES
import dev.droidwebscr.server.protocol.MessageType
import dev.droidwebscr.server.protocol.StreamId
import java.io.Closeable
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

class ProductVerificationServer(
    private val socketName: String,
    private val captureBackend: DisplayCaptureBackend = ShellDisplayCaptureBackend(),
    private val encoder: VideoEncoder = MediaCodecVideoEncoder(),
    private val inputInjectorFactory: (InputDisplayBounds) -> InputInjector = { bounds -> ShellInputInjector(displayBounds = bounds) },
) {
    fun serveOnce() {
        LocalServerSocket(socketName).use { server ->
            server.accept().use { socket ->
                serveConnection(socket.inputStream, socket.outputStream)
            }
        }
    }

    private fun serveConnection(input: InputStream, output: OutputStream) {
        val hello = readFrame(input)
        require(hello.header.type == MessageType.SESSION_HELLO.value) {
            "Expected SESSION_HELLO, received message type ${hello.header.type}."
        }
        writeFrame(
            output,
            Frame(
                FrameHeader(
                    type = MessageType.SESSION_HELLO_ACK.value,
                    streamId = StreamId.Session.value,
                    sequence = hello.header.sequence,
                ),
                ByteArray(0),
            ),
        )

        val config = VideoEncoderConfig(width = 720, height = 1280, bitrate = 2_000_000, fps = 30).validated()
        emitMediaCodecVideoFrames(output, config)

        val control = readFrame(input)
        val action = parseSystemAction(control).getOrElse { error ->
            writeLog(output, "control:rejected:${error.message}")
            return
        }
        val inputInjector = inputInjectorFactory(InputDisplayBounds(config.width, config.height))
        val result = inputInjector.injectSystemAction(action)
        writeLog(output, "control:${action.name.lowercase()}:$result")
    }

    private fun emitMediaCodecVideoFrames(output: OutputStream, config: VideoEncoderConfig) {
        encoder.start(config)
        val captureSession = captureBackend.start(
            CaptureConfig(displayId = 0, width = config.width, height = config.height),
            encoder.inputSurface(),
        )
        try {
            emitFirstEncodedFrames(output, config)
        } finally {
            captureSession.stop()
            encoder.stop()
        }
    }

    private fun emitFirstEncodedFrames(output: OutputStream, config: VideoEncoderConfig) {
        var sequence = 1uL
        var configSent = false
        var frameSent = false
        val deadline = System.nanoTime() + 5_000_000_000L
        encoder.requestKeyFrame()
        while (System.nanoTime() < deadline && (!configSent || !frameSent)) {
            val packet = encoder.dequeueOutput(100_000) ?: continue
            if (packet.codecConfig) {
                writeFrame(output, VideoProtocol.createVideoConfigFrame(config, packet.bytes, sequence++))
                configSent = true
            } else {
                writeFrame(
                    output,
                    VideoProtocol.createVideoFrame(packet.bytes, packet.keyFrame, packet.timestampUs, sequence++),
                )
                frameSent = true
            }
        }
        require(configSent) { "MediaCodec did not emit VIDEO_CONFIG before timeout." }
        require(frameSent) { "MediaCodec did not emit VIDEO_FRAME before timeout." }
    }

    private fun parseSystemAction(control: Frame): Result<SystemAction> = runCatching {
        require(control.header.type == MessageType.CONTROL_SYSTEM.value) {
            "Expected CONTROL_SYSTEM, received message type ${control.header.type}."
        }
        require(control.header.streamId == StreamId.Control.value) {
            "CONTROL_SYSTEM must use the control stream."
        }
        require(control.payload.size == 1) { "CONTROL_SYSTEM payload must contain exactly one action byte." }
        when (control.payload[0].toInt()) {
            0 -> SystemAction.Back
            1 -> SystemAction.Home
            else -> throw IllegalArgumentException("Unsupported CONTROL_SYSTEM action ${control.payload[0].toInt()}.")
        }
    }

    private fun writeLog(output: OutputStream, message: String) {
        val payload = message.encodeToByteArray()
        writeFrame(
            output,
            Frame(
                FrameHeader(
                    type = MessageType.LOG_RECORD.value,
                    streamId = StreamId.Log.value,
                    payloadLength = payload.size.toUInt(),
                    sequence = 1u,
                ),
                payload,
            ),
        )
    }

    private fun readFrame(input: InputStream): Frame = FrameCodec.decode(readFrameBytes(input))

    private fun readFrameBytes(input: InputStream): ByteArray {
        val header = ByteArray(HEADER_LENGTH_BYTES)
        readFully(input, header)
        val payloadLength = ByteBuffer.wrap(header).order(ByteOrder.BIG_ENDIAN).getInt(16)
        require(payloadLength >= 0) { "Payload length must be non-negative." }
        require(payloadLength <= MAX_PAYLOAD_LENGTH_BYTES) {
            "Payload length $payloadLength exceeds limit $MAX_PAYLOAD_LENGTH_BYTES."
        }
        val frame = ByteArray(HEADER_LENGTH_BYTES + payloadLength)
        header.copyInto(frame)
        if (payloadLength > 0) {
            readFully(input, frame, HEADER_LENGTH_BYTES, payloadLength)
        }
        return frame
    }

    private fun readFully(input: InputStream, buffer: ByteArray, offset: Int = 0, length: Int = buffer.size) {
        var read = 0
        while (read < length) {
            val count = input.read(buffer, offset + read, length - read)
            if (count < 0) {
                throw EOFException("Input ended before a complete protocol frame was received.")
            }
            read += count
        }
    }

    private fun writeFrame(output: OutputStream, frame: Frame) {
        output.write(FrameCodec.encode(frame))
        output.flush()
    }

    private companion object {
        const val MAX_PAYLOAD_LENGTH_BYTES = 16 * 1024 * 1024
    }
}

private inline fun <T : Closeable?, R> T.use(block: (T) -> R): R {
    var failure: Throwable? = null
    try {
        return block(this)
    } catch (throwable: Throwable) {
        failure = throwable
        throw throwable
    } finally {
        when {
            this == null -> Unit
            failure == null -> close()
            else -> {
                try {
                    close()
                } catch (closeFailure: Throwable) {
                    failure.addSuppressed(closeFailure)
                }
            }
        }
    }
}
