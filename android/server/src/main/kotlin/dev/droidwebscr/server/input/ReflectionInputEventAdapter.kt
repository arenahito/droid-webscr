package dev.droidwebscr.server.input

class ReflectionInputEventAdapter : InputEventAdapter {
    override fun injectKey(event: KeyControlMessage): Boolean {
        val validated = event.validated()
        val action = when (validated.action) {
            KeyAction.Down -> ACTION_DOWN
            KeyAction.Up -> ACTION_UP
        }
        return inject(createKeyEvent(action, validated.keyCode, validated.metaState, validated.repeat))
    }

    override fun injectPointer(event: PointerControlMessage): Boolean {
        val action = when (event.action) {
            PointerAction.Down -> MOTION_ACTION_DOWN
            PointerAction.Move -> MOTION_ACTION_MOVE
            PointerAction.Up -> MOTION_ACTION_UP
            PointerAction.Cancel -> MOTION_ACTION_CANCEL
        }
        return inject(createMotionEvent(action, event.x.toFloat(), event.y.toFloat(), event.pressure))
    }

    override fun injectText(text: String): Boolean {
        TextControlMessage(text).validated()
        return false
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

    private companion object {
        const val ACTION_DOWN = 0
        const val ACTION_UP = 1
        const val MOTION_ACTION_DOWN = 0
        const val MOTION_ACTION_UP = 1
        const val MOTION_ACTION_MOVE = 2
        const val MOTION_ACTION_CANCEL = 3
        const val INJECT_INPUT_EVENT_MODE_ASYNC = 0
    }
}
