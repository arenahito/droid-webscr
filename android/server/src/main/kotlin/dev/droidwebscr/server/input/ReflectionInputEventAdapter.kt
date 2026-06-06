package dev.droidwebscr.server.input

import java.util.concurrent.TimeUnit

class ReflectionInputEventAdapter : InputEventAdapter {
    override fun injectKey(event: KeyControlMessage): Boolean {
        val validated = event.validated()
        val action = when (validated.action) {
            KeyAction.Down -> ACTION_DOWN
            KeyAction.Up -> ACTION_UP
        }
        val reflected = inject(
            setEventSource(createKeyEvent(action, validated.keyCode, validated.metaState, validated.repeat), SOURCE_KEYBOARD),
        )
        return reflected || when (validated.action) {
            KeyAction.Down -> injectShell("keyevent", validated.keyCode.toString())
            KeyAction.Up -> true
        }
    }

    override fun injectPointer(event: PointerControlMessage): Boolean {
        val action = when (event.action) {
            PointerAction.Down -> MOTION_ACTION_DOWN
            PointerAction.Move -> MOTION_ACTION_MOVE
            PointerAction.Up -> MOTION_ACTION_UP
            PointerAction.Cancel -> MOTION_ACTION_CANCEL
        }
        val reflected = inject(
            setEventSource(
                createMotionEvent(action, event.x.toFloat(), event.y.toFloat(), event.pressure),
                SOURCE_TOUCHSCREEN,
            ),
        )
        return reflected || injectPointerWithShell(event)
    }

    override fun injectText(text: String): Boolean {
        TextControlMessage(text).validated()
        val keyCharacterMapClass = Class.forName("android.view.KeyCharacterMap")
        val virtualKeyboard = keyCharacterMapClass.getField("VIRTUAL_KEYBOARD").getInt(null)
        val keyCharacterMap = requireNotNull(
            keyCharacterMapClass.getMethod("load", Int::class.javaPrimitiveType)
                .invoke(null, virtualKeyboard),
        )
        val events = keyCharacterMapClass
            .getMethod("getEvents", CharArray::class.java)
            .invoke(keyCharacterMap, text.toCharArray()) as? Array<*>
            ?: return false
        val reflected = events.isNotEmpty() && events.all { event -> inject(requireNotNull(event)) }
        return reflected || injectShell("text", text.replace(" ", "%s"))
    }

    private fun inject(event: Any): Boolean {
        val (inputManagerClass, inputManager) = inputManager()
        val inputEventClass = Class.forName("android.view.InputEvent")
        val method = inputManagerClass.getMethod("injectInputEvent", inputEventClass, Int::class.javaPrimitiveType)
        return method.invoke(inputManager, event, INJECT_INPUT_EVENT_MODE_ASYNC) as Boolean
    }

    private fun inputManager(): Pair<Class<*>, Any> {
        return runCatching {
            val inputManagerClass = Class.forName("android.hardware.input.InputManagerGlobal")
            inputManagerClass to requireNotNull(inputManagerClass.getMethod("getInstance").invoke(null))
        }.getOrElse {
            val inputManagerClass = Class.forName("android.hardware.input.InputManager")
            inputManagerClass to requireNotNull(inputManagerClass.getMethod("getInstance").invoke(null))
        }
    }

    private fun createKeyEvent(action: Int, keyCode: Int, metaState: Int, repeat: Int): Any {
        val now = System.currentTimeMillis()
        val keyEventClass = Class.forName("android.view.KeyEvent")
        val constructor = keyEventClass.getConstructor(
            Long::class.javaPrimitiveType,
            Long::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
        )
        return requireNotNull(constructor.newInstance(now, now, action, keyCode, repeat, metaState, 0, 0))
    }

    private fun createMotionEvent(action: Int, x: Float, y: Float, pressure: Float): Any {
        val now = System.currentTimeMillis()
        val motionEventClass = Class.forName("android.view.MotionEvent")
        return requireNotNull(motionEventClass.getMethod(
            "obtain",
            Long::class.javaPrimitiveType,
            Long::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Float::class.javaPrimitiveType,
            Float::class.javaPrimitiveType,
            Float::class.javaPrimitiveType,
            Float::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Float::class.javaPrimitiveType,
            Float::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
        ).invoke(null, now, now, action, x, y, pressure, 1.0f, 0, 1.0f, 1.0f, 0, 0))
    }

    private fun setEventSource(event: Any, source: Int): Any {
        event.javaClass.getMethod("setSource", Int::class.javaPrimitiveType).invoke(event, source)
        return event
    }

    private fun injectPointerWithShell(event: PointerControlMessage): Boolean = when (event.action) {
        PointerAction.Down -> injectShell("tap", event.x.toString(), event.y.toString())
        PointerAction.Move -> injectShell("swipe", event.x.toString(), event.y.toString(), event.x.toString(), event.y.toString(), "1")
        PointerAction.Up,
        PointerAction.Cancel,
        -> true
    }

    private fun injectShell(vararg args: String): Boolean = runCatching {
        val process = ProcessBuilder("/system/bin/input", *args).redirectErrorStream(true).start()
        if (!process.waitFor(2, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            return@runCatching false
        }
        process.exitValue() == 0
    }.getOrDefault(false)

    private companion object {
        const val ACTION_DOWN = 0
        const val ACTION_UP = 1
        const val MOTION_ACTION_DOWN = 0
        const val MOTION_ACTION_UP = 1
        const val MOTION_ACTION_MOVE = 2
        const val MOTION_ACTION_CANCEL = 3
        const val INJECT_INPUT_EVENT_MODE_ASYNC = 0
        const val SOURCE_KEYBOARD = 0x00000101
        const val SOURCE_TOUCHSCREEN = 0x00001002
    }
}
