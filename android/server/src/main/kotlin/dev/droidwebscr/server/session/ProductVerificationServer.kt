package dev.droidwebscr.server.session

import android.content.res.Resources
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class ProductVerificationServer(
    private val socketName: String,
    private val captureBackend: DisplayCaptureBackend = ShellDisplayCaptureBackend(),
    private val encoder: VideoEncoder = MediaCodecVideoEncoder(),
    private val inputInjectorFactory: (InputDisplayBounds) -> InputInjector = { bounds -> ShellInputInjector(displayBounds = bounds) },
) {
    fun serveOnce() {
        LocalServerSocket(socketName).use { server ->
            println("droid-webscr:ready:$socketName")
            server.accept().use { socket ->
                serveConnection(socket.inputStream, socket.outputStream)
            }
        }
    }

    private fun serveConnection(input: InputStream, output: OutputStream) {
        val frameWriter = SessionFrameWriter(output)
        val hello = readFrame(input)
        require(hello.header.type == MessageType.SESSION_HELLO.value) {
            "Expected SESSION_HELLO, received message type ${hello.header.type}."
        }
        frameWriter.writeFrame(
            Frame(
                FrameHeader(
                    type = MessageType.SESSION_HELLO_ACK.value,
                    streamId = StreamId.Session.value,
                    sequence = hello.header.sequence,
                ),
                ByteArray(0),
            ),
        )

        val displaySize = readCurrentDisplaySize()
        val outputSize = displaySize.fitWithin(maxWidth = 1080, maxHeight = 1920)
        val config = VideoEncoderConfig(
            width = outputSize.width,
            height = outputSize.height,
            bitrate = 2_000_000,
            fps = 30,
        ).validated()
        encoder.start(config)
        val captureSession = captureBackend.start(
            CaptureConfig(
                displayId = 0,
                width = config.width,
                height = config.height,
                sourceWidth = displaySize.width,
                sourceHeight = displaySize.height,
            ),
            encoder.inputSurface(),
        )
        val videoStream = VideoStreamPump(
            encoder = encoder,
            initialConfig = config,
            writeFrame = frameWriter::writeFrame,
        )
        try {
            videoStream.start()
            require(videoStream.awaitFirstFrame()) { "MediaCodec did not emit VIDEO_CONFIG and VIDEO_FRAME before timeout." }
            val inputInjector = inputInjectorFactory(InputDisplayBounds(displaySize.width, displaySize.height))
            val dispatcher = ControlFrameDispatcher(
                bounds = InputDisplayBounds(config.width, config.height),
                inputBounds = InputDisplayBounds(displaySize.width, displaySize.height),
                inputInjector = inputInjector,
                reconfigureVideo = { nextConfig ->
                    encoder.reconfigure(nextConfig)
                    videoStream.updateConfig(nextConfig)
                },
            )
            try {
                readAndDispatchControls(input, frameWriter, dispatcher)
            } finally {
                if (inputInjector is Closeable) {
                    inputInjector.close()
                }
            }
        } finally {
            videoStream.stop()
            captureSession.stop()
            encoder.stop()
        }
    }

    private fun readAndDispatchControls(
        input: InputStream,
        frameWriter: SessionFrameWriter,
        dispatcher: ControlFrameDispatcher,
    ) {
        while (true) {
            val frame = try {
                readFrame(input)
            } catch (_: EOFException) {
                return
            }
            val log = runCatching { dispatcher.dispatch(frame) }
                .getOrElse { error -> "control:rejected:${error.message}" }
            writeLog(frameWriter, log)
        }
    }

    private fun writeLog(frameWriter: SessionFrameWriter, message: String) {
        val payload = message.encodeToByteArray()
        frameWriter.writeFrame(
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

    private companion object {
        const val MAX_PAYLOAD_LENGTH_BYTES = 16 * 1024 * 1024
    }
}

internal class SessionFrameWriter(private val output: OutputStream) {
    @Synchronized
    fun writeFrame(frame: Frame) {
        output.write(FrameCodec.encode(frame))
        output.flush()
    }
}

internal class VideoStreamPump(
    private val encoder: VideoEncoder,
    initialConfig: VideoEncoderConfig,
    private val writeFrame: (Frame) -> Unit,
) {
    private val running = AtomicBoolean(false)
    private val firstFrame = CountDownLatch(1)
    @Volatile
    private var config = initialConfig
    private var sequence = 1uL
    private var configSent = false
    private var renderedFrameSent = false
    private var worker: Thread? = null

    fun start() {
        if (!running.compareAndSet(false, true)) {
            return
        }
        encoder.requestKeyFrame()
        worker = Thread(::pump, "droid-webscr-video-stream").also { thread ->
            thread.isDaemon = true
            thread.start()
        }
    }

    fun awaitFirstFrame(timeoutMs: Long = 5_000): Boolean = firstFrame.await(timeoutMs, TimeUnit.MILLISECONDS)

    fun updateConfig(nextConfig: VideoEncoderConfig) {
        config = nextConfig
        encoder.requestKeyFrame()
    }

    fun stop() {
        running.set(false)
        worker?.interrupt()
        worker = null
    }

    private fun pump() {
        while (running.get()) {
            val packet = encoder.dequeueOutput(100_000) ?: continue
            if (packet.codecConfig) {
                writeFrame(VideoProtocol.createVideoConfigFrame(config, packet.bytes, sequence++))
                configSent = true
            } else {
                writeFrame(
                    VideoProtocol.createVideoFrame(packet.bytes, packet.keyFrame, packet.timestampUs, sequence++),
                )
                renderedFrameSent = true
            }
            if (configSent && renderedFrameSent) {
                firstFrame.countDown()
            }
        }
    }
}

internal data class DisplaySize(val width: Int, val height: Int) {
    fun fitWithin(maxWidth: Int, maxHeight: Int): DisplaySize {
        val scale = minOf(maxWidth.toDouble() / width.toDouble(), maxHeight.toDouble() / height.toDouble(), 1.0)
        return DisplaySize(
            width = (width * scale).toInt().roundDownToEven(),
            height = (height * scale).toInt().roundDownToEven(),
        )
    }
}

private fun readCurrentDisplaySize(): DisplaySize {
    return sequenceOf(
        { readWindowManagerDisplaySize() },
        { readResourcesDisplaySize() },
        { readWmCommandDisplaySize() },
    ).firstNotNullOfOrNull { reader ->
        val displaySize = reader()
        if (displaySize != null && displaySize.isUsable()) displaySize else null
    }
        ?: error("Unable to determine Android display size.")
}

private fun readWindowManagerDisplaySize(): DisplaySize? = runCatching {
    val pointClass = Class.forName("android.graphics.Point")
    val point = pointClass.getConstructor().newInstance()
    val service = Class.forName("android.view.WindowManagerGlobal")
        .getMethod("getWindowManagerService")
        .invoke(null)
    service.javaClass.methods.firstOrNull {
        it.name == "getInitialDisplaySize" && it.parameterTypes.size == 2
    }?.invoke(service, 0, point) ?: return null
    DisplaySize(
        width = pointClass.getField("x").getInt(point),
        height = pointClass.getField("y").getInt(point),
    )
}.getOrNull()

private fun readResourcesDisplaySize(): DisplaySize {
    val metrics = Resources.getSystem().displayMetrics
    return DisplaySize(width = metrics.widthPixels, height = metrics.heightPixels)
}

private fun readWmCommandDisplaySize(): DisplaySize? = runCatching {
    val process = ProcessBuilder("wm", "size")
        .redirectError(ProcessBuilder.Redirect.PIPE)
        .start()
    val output = process.inputStream.bufferedReader().use { it.readText() }
    process.waitFor()
    parseWmSizeOutput(output)
}.getOrNull()

internal fun parseWmSizeOutput(output: String): DisplaySize? {
    val matches = Regex("""(?m)^(Override|Physical) size:\s*(\d+)x(\d+)\s*$""").findAll(output).toList()
    return matches
        .firstOrNull { match -> match.groupValues[1] == "Override" }
        .orElse(matches.firstOrNull())
        ?.let { match -> DisplaySize(match.groupValues[2].toInt(), match.groupValues[3].toInt()) }
        ?.takeIf(DisplaySize::isUsable)
}

private fun DisplaySize.isUsable(): Boolean = width >= 64 && height >= 64

private fun <T> T?.orElse(fallback: T?): T? = this ?: fallback

private fun Int.roundDownToEven(): Int = if (this % 2 == 0) this else this - 1

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
