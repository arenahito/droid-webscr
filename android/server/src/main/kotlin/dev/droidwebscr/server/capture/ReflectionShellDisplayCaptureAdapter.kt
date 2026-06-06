package dev.droidwebscr.server.capture

import android.view.Surface

class ReflectionShellDisplayCaptureAdapter : ShellDisplayCaptureAdapter {
    override fun start(config: CaptureConfig, inputSurface: Any): CaptureSession {
        val surface = inputSurface as Surface
        createVirtualDisplay(config, surface)?.let { virtualDisplay ->
            return CaptureSession {
                runCatching {
                    virtualDisplay.javaClass.getMethod("release").invoke(virtualDisplay)
                }
            }
        }
        val surfaceControl = Class.forName("android.view.SurfaceControl")
        val displayToken = createDisplay(surfaceControl)
        try {
            setDisplaySurface(surfaceControl, displayToken, inputSurface, config)
        } catch (error: ReflectiveOperationException) {
            destroyDisplay(surfaceControl, displayToken)
            throw UnsupportedOperationException("display surface capture unavailable", error)
        }
        setDisplayPowerMode(surfaceControl, displayToken, POWER_MODE_NORMAL)
        return CaptureSession {
            setDisplayPowerMode(surfaceControl, displayToken, POWER_MODE_OFF)
            destroyDisplay(surfaceControl, displayToken)
        }
    }

    private fun createVirtualDisplay(config: CaptureConfig, surface: Surface): Any? = runCatching {
        Class.forName("android.hardware.display.DisplayManager")
            .getMethod(
                "createVirtualDisplay",
                String::class.java,
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
                Surface::class.java,
            )
            .invoke(null, "droid-webscr", config.width, config.height, config.displayId, surface)
    }.getOrNull()

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
                    createRect(0, 0, config.sourceWidth, config.sourceHeight),
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
            createRect(0, 0, config.sourceWidth, config.sourceHeight),
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

    private fun setDisplayPowerMode(surfaceControl: Class<*>, displayToken: Any, mode: Int) {
        runCatching {
            surfaceControl.getMethod(
                "setDisplayPowerMode",
                Class.forName("android.os.IBinder"),
                Int::class.javaPrimitiveType,
            ).invoke(null, displayToken, mode)
        }
    }

    private companion object {
        const val POWER_MODE_OFF = 0
        const val POWER_MODE_NORMAL = 2
    }
}
