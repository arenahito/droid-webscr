package dev.droidwebscr.server.capture

import android.graphics.BitmapFactory
import android.graphics.Rect
import android.view.Surface
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class ReflectionShellDisplayCaptureAdapter : ShellDisplayCaptureAdapter {
    override fun start(config: CaptureConfig, inputSurface: Any): CaptureSession {
        val surfaceControl = Class.forName("android.view.SurfaceControl")
        val displayToken = try {
            createDisplay(surfaceControl)
        } catch (_: NoSuchMethodException) {
            return ScreencapSurfaceCaptureSession(config, inputSurface as Surface).also { it.start() }
        }
        try {
            setDisplaySurface(surfaceControl, displayToken, inputSurface, config)
        } catch (error: ReflectiveOperationException) {
            destroyDisplay(surfaceControl, displayToken)
            throw UnsupportedOperationException("display surface capture unavailable", error)
        }
        return CaptureSession { destroyDisplay(surfaceControl, displayToken) }
    }

    private fun createDisplay(surfaceControl: Class<*>): Any {
        val method = surfaceControl.getMethod(
            "createDisplay",
            String::class.java,
            Boolean::class.javaPrimitiveType,
        )
        return requireNotNull(method.invoke(null, "droid-webscr", false))
    }

    private fun setDisplaySurface(
        surfaceControl: Class<*>,
        displayToken: Any,
        inputSurface: Any,
        config: CaptureConfig,
    ) {
        val openTransaction = surfaceControl.methods.firstOrNull { it.name == "openTransaction" }
        val closeTransaction = surfaceControl.methods.firstOrNull { it.name == "closeTransaction" }
        val setDisplaySurface = surfaceControl.methods.firstOrNull {
            it.name == "setDisplaySurface" && it.parameterTypes.size == 2
        }
        val setDisplayLayerStack = surfaceControl.methods.firstOrNull {
            it.name == "setDisplayLayerStack" && it.parameterTypes.size == 2
        }
        val setDisplayProjection = surfaceControl.methods.firstOrNull {
            it.name == "setDisplayProjection" && it.parameterTypes.size == 4
        }
        if (openTransaction != null && closeTransaction != null && setDisplaySurface != null) {
            openTransaction.invoke(null)
            try {
                setDisplaySurface.invoke(null, displayToken, inputSurface)
                setDisplayLayerStack?.invoke(null, displayToken, 0)
                setDisplayProjection?.invoke(
                    null,
                    displayToken,
                    0,
                    createRect(0, 0, config.width, config.height),
                    createRect(0, 0, config.width, config.height),
                )
            } finally {
                closeTransaction.invoke(null)
            }
            return
        }

        val transactionClass = Class.forName("android.view.SurfaceControl\$Transaction")
        val transaction = transactionClass.getConstructor().newInstance()
        transactionClass.methods.first {
            it.name == "setDisplaySurface" && it.parameterTypes.size == 2
        }.invoke(transaction, displayToken, inputSurface)
        transactionClass.methods.firstOrNull {
            it.name == "setDisplayLayerStack" && it.parameterTypes.size == 2
        }?.invoke(transaction, displayToken, 0)
        transactionClass.methods.firstOrNull {
            it.name == "setDisplayProjection" && it.parameterTypes.size == 4
        }?.invoke(
            transaction,
            displayToken,
            0,
            createRect(0, 0, config.width, config.height),
            createRect(0, 0, config.width, config.height),
        )
        transactionClass.getMethod("apply").invoke(transaction)
    }

    private fun createRect(left: Int, top: Int, right: Int, bottom: Int): Any {
        val rectClass = Class.forName("android.graphics.Rect")
        return rectClass
            .getConstructor(
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
            )
            .newInstance(left, top, right, bottom)
    }

    private fun destroyDisplay(surfaceControl: Class<*>, displayToken: Any) {
        runCatching {
            surfaceControl.getMethod("destroyDisplay", Class.forName("android.os.IBinder"))
                .invoke(null, displayToken)
        }
    }
}

private class ScreencapSurfaceCaptureSession(
    private val config: CaptureConfig,
    private val surface: Surface,
) : CaptureSession {
    private val running = AtomicBoolean(false)
    private var worker: Thread? = null

    fun start() {
        running.set(true)
        worker = thread(name = "droid-webscr-screencap-capture", isDaemon = true) {
            while (running.get()) {
                val drawn = runCatching { drawScreencap() }.getOrDefault(false)
                try {
                    Thread.sleep(if (drawn) 100 else 250)
                } catch (_: InterruptedException) {
                    return@thread
                }
            }
        }
    }

    override fun stop() {
        running.set(false)
        worker?.interrupt()
        worker = null
    }

    private fun drawScreencap(): Boolean {
        val process = ProcessBuilder("screencap", "-p")
            .redirectError(ProcessBuilder.Redirect.PIPE)
            .start()
        val bitmap = process.inputStream.use(BitmapFactory::decodeStream) ?: return false
        val canvas = surface.lockCanvas(null)
        try {
            canvas.drawBitmap(bitmap, null, Rect(0, 0, config.width, config.height), null)
            return true
        } finally {
            surface.unlockCanvasAndPost(canvas)
            bitmap.recycle()
            process.destroy()
        }
    }
}
