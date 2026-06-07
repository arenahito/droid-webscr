package dev.droidwebscr.server.input

import android.os.SystemClock
import java.util.concurrent.TimeUnit

class ReflectionInputEventAdapter : InputEventAdapter {
    private val pointerEventClock = PointerEventClock()
    private val pointerGestureState = PointerGestureState()
    private val shellPointerFallback = ShellPointerFallback()

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
        val eventTime = pointerEventClock.next(event.action, SystemClock.uptimeMillis())
        val snapshot = pointerGestureState.snapshot()
        val gesture = pointerGestureState.update(event, eventTime)
        val reflected = injectMotionEvents(gesture, eventTime)
        val accepted = reflected || (gesture.canFallbackToShell(snapshot) && injectPointerWithShell(event))
        if (!accepted) {
            pointerGestureState.restore(snapshot)
        }
        return accepted
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

    private fun inject(event: Any, mode: Int = INJECT_INPUT_EVENT_MODE_ASYNC): Boolean {
        val (inputManagerClass, inputManager) = inputManager()
        val inputEventClass = Class.forName("android.view.InputEvent")
        val method = inputManagerClass.getMethod("injectInputEvent", inputEventClass, Int::class.javaPrimitiveType)
        return method.invoke(inputManager, event, mode) as Boolean
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
        val now = SystemClock.uptimeMillis()
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

    private fun createMotionEvent(
        gesture: PointerGestureUpdate,
        eventTime: Long,
        action: Int = gesture.action,
        buttonState: Int = gesture.buttonState,
    ): Any {
        val motionEventClass = Class.forName("android.view.MotionEvent")
        val pointerPropertiesClass = Class.forName("android.view.MotionEvent\$PointerProperties")
        val pointerCoordsClass = Class.forName("android.view.MotionEvent\$PointerCoords")
        val properties = java.lang.reflect.Array.newInstance(pointerPropertiesClass, gesture.pointers.size)
        val coords = java.lang.reflect.Array.newInstance(pointerCoordsClass, gesture.pointers.size)
        for ((arrayIndex, pointer) in gesture.pointers.withIndex()) {
            val property = requireNotNull(pointerPropertiesClass.getConstructor().newInstance())
            pointerPropertiesClass.getField("id").setInt(property, pointer.id)
            pointerPropertiesClass.getField("toolType").setInt(property, pointer.toolType)
            java.lang.reflect.Array.set(properties, arrayIndex, property)

            val coord = requireNotNull(pointerCoordsClass.getConstructor().newInstance())
            pointerCoordsClass.getField("x").setFloat(coord, pointer.x.toFloat())
            pointerCoordsClass.getField("y").setFloat(coord, pointer.y.toFloat())
            pointerCoordsClass.getField("pressure").setFloat(coord, pointer.pressure)
            pointerCoordsClass.getField("size").setFloat(coord, 1.0f)
            java.lang.reflect.Array.set(coords, arrayIndex, coord)
        }
        val motionEvent = requireNotNull(motionEventClass.getMethod(
            "obtain",
            Long::class.javaPrimitiveType,
            Long::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            properties.javaClass,
            coords.javaClass,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Float::class.javaPrimitiveType,
            Float::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
        ).invoke(
            null,
            gesture.downTime,
            eventTime,
            action,
            gesture.pointers.size,
            properties,
            coords,
            0,
            buttonState,
            1.0f,
            1.0f,
            0,
            0,
            gesture.source,
            0,
        ))
        setDisplayId(motionEvent, gesture.displayId)
        return motionEvent
    }

    private fun injectMotionEvents(gesture: PointerGestureUpdate, eventTime: Long): Boolean {
        if (gesture.source != SOURCE_MOUSE) {
            return injectMotionEvent(gesture, eventTime)
        }
        if (gesture.action == MOTION_ACTION_DOWN && gesture.actionButton != 0) {
            return injectMotionEvent(gesture, eventTime) &&
                injectMotionEvent(gesture, eventTime, MOTION_ACTION_BUTTON_PRESS, gesture.buttonState)
        }
        if (gesture.action == MOTION_ACTION_UP && gesture.actionButton != 0) {
            return injectMotionEvent(gesture, eventTime, MOTION_ACTION_BUTTON_RELEASE, 0) &&
                injectMotionEvent(gesture, eventTime, MOTION_ACTION_UP, 0)
        }
        return injectMotionEvent(gesture, eventTime)
    }

    private fun injectMotionEvent(
        gesture: PointerGestureUpdate,
        eventTime: Long,
        action: Int = gesture.action,
        buttonState: Int = gesture.buttonState,
    ): Boolean = inject(
        setActionButton(
            setEventSource(
                createMotionEvent(gesture, eventTime, action, buttonState),
                gesture.source,
            ),
            gesture.actionButton,
        ),
        INJECT_INPUT_EVENT_MODE_ASYNC,
    )

    private fun setEventSource(event: Any, source: Int): Any {
        event.javaClass.getMethod("setSource", Int::class.javaPrimitiveType).invoke(event, source)
        return event
    }

    private fun setDisplayId(event: Any, displayId: Int): Any {
        runCatching {
            event.javaClass.getMethod("setDisplayId", Int::class.javaPrimitiveType).invoke(event, displayId)
        }
        return event
    }

    private fun setActionButton(event: Any, actionButton: Int): Any {
        if (actionButton != 0) {
            runCatching {
                event.javaClass.getMethod("setActionButton", Int::class.javaPrimitiveType).invoke(event, actionButton)
            }
        }
        return event
    }

    private fun injectPointerWithShell(event: PointerControlMessage): Boolean =
        shellPointerFallback.inject(event) { args -> injectShell(*args.toTypedArray()) }

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
        const val MOTION_ACTION_POINTER_DOWN = 5
        const val MOTION_ACTION_POINTER_UP = 6
        const val MOTION_ACTION_BUTTON_PRESS = 11
        const val MOTION_ACTION_BUTTON_RELEASE = 12
        const val INJECT_INPUT_EVENT_MODE_ASYNC = 0
        const val INJECT_INPUT_EVENT_MODE_WAIT_FOR_FINISH = 2
        const val SOURCE_KEYBOARD = 0x00000101
        const val SOURCE_MOUSE = 0x00002002
        const val SOURCE_TOUCHSCREEN = 0x00001002
        const val TOOL_TYPE_FINGER = 1
        const val TOOL_TYPE_MOUSE = 3
    }
}

internal data class ActivePointer(
    val id: Int,
    val index: Int,
    val x: Int,
    val y: Int,
    val pressure: Float,
    val toolType: Int,
)

internal data class PointerGestureUpdate(
    val action: Int,
    val actionButton: Int,
    val buttonState: Int,
    val displayId: Int,
    val downTime: Long,
    val pointers: List<ActivePointer>,
    val source: Int,
)

internal class PointerEventClock(
    private val minimumMoveIntervalMs: Long = 8L,
) {
    private var lastEventTime: Long? = null

    fun next(action: PointerAction, now: Long): Long {
        val last = lastEventTime
        val next = if (last == null || action == PointerAction.Down) {
            if (last == null) now else maxOf(now, last + 1)
        } else {
            maxOf(now, last + minimumMoveIntervalMs)
        }
        lastEventTime = next
        return next
    }
}

internal class PointerGestureState {
    private val pointers = mutableMapOf<Int, ActivePointer>()
    private var gestureDownTime: Long? = null
    private var gestureActionButton = 0
    private var gestureSource = SOURCE_TOUCHSCREEN
    private var gestureToolType = TOOL_TYPE_FINGER

    fun update(event: PointerControlMessage, eventTime: Long): PointerGestureUpdate {
        val downTime = gestureDownTime ?: eventTime
        if (event.action == PointerAction.Down && gestureDownTime == null) {
            gestureDownTime = eventTime
            val nonPrimaryButtonPressed = event.buttons and BUTTON_PRIMARY.inv() != 0
            gestureSource = if (nonPrimaryButtonPressed) SOURCE_MOUSE else SOURCE_TOUCHSCREEN
            gestureToolType = if (nonPrimaryButtonPressed) TOOL_TYPE_MOUSE else TOOL_TYPE_FINGER
            gestureActionButton = if (nonPrimaryButtonPressed) event.buttons else 0
        }
        when (event.action) {
            PointerAction.Down -> {
                val index = pointers.size
                pointers[event.pointerId] = ActivePointer(
                    event.pointerId,
                    index,
                    event.x,
                    event.y,
                    event.pressure,
                    gestureToolType,
                )
                val eventPointers = activePointers()
                if (index == 0) {
                    return event.toUpdate(MOTION_ACTION_DOWN, downTime, eventPointers)
                } else {
                    return event.toUpdate(MOTION_ACTION_POINTER_DOWN or (index shl 8), downTime, eventPointers)
                }
            }
            PointerAction.Move -> {
                pointers[event.pointerId]?.let { current ->
                    pointers[event.pointerId] = current.copy(x = event.x, y = event.y, pressure = event.pressure)
                }
                return event.toUpdate(MOTION_ACTION_MOVE, downTime, activePointers())
            }
            PointerAction.Up,
            PointerAction.Cancel,
            -> {
                pointers[event.pointerId]?.let { current ->
                    pointers[event.pointerId] = current.copy(x = event.x, y = event.y, pressure = event.pressure)
                }
                val pointer = pointers[event.pointerId]
                val eventPointers = activePointers()
                val actionCode = if (event.action == PointerAction.Cancel) {
                    MOTION_ACTION_CANCEL
                } else if (pointers.size <= 1) {
                    MOTION_ACTION_UP
                } else {
                    MOTION_ACTION_POINTER_UP or ((pointer?.index ?: 0) shl 8)
                }
                val update = event.toUpdate(actionCode, downTime, eventPointers)
                if (event.action == PointerAction.Cancel) {
                    pointers.clear()
                } else {
                    pointers.remove(event.pointerId)
                    reindexPointers()
                }
                if (pointers.isEmpty()) {
                    resetGesture()
                }
                return update
            }
        }
    }

    fun activePointers(): List<ActivePointer> = pointers.values.sortedBy { it.index }

    fun snapshot(): PointerGestureSnapshot = PointerGestureSnapshot(
        pointers = pointers.toMap(),
        gestureDownTime = gestureDownTime,
        gestureActionButton = gestureActionButton,
        gestureSource = gestureSource,
        gestureToolType = gestureToolType,
    )

    fun restore(snapshot: PointerGestureSnapshot) {
        pointers.clear()
        pointers.putAll(snapshot.pointers)
        gestureDownTime = snapshot.gestureDownTime
        gestureActionButton = snapshot.gestureActionButton
        gestureSource = snapshot.gestureSource
        gestureToolType = snapshot.gestureToolType
    }

    private fun resetGesture() {
        gestureDownTime = null
        gestureActionButton = 0
        gestureSource = SOURCE_TOUCHSCREEN
        gestureToolType = TOOL_TYPE_FINGER
    }

    private fun reindexPointers() {
        val ordered = pointers.values.sortedBy { it.index }
        pointers.clear()
        for ((index, pointer) in ordered.withIndex()) {
            pointers[pointer.id] = pointer.copy(index = index)
        }
    }

    private fun PointerControlMessage.toUpdate(
        action: Int,
        downTime: Long,
        pointers: List<ActivePointer>,
    ): PointerGestureUpdate = PointerGestureUpdate(
        action = action,
        actionButton = gestureActionButton,
        buttonState = gestureButtonState(this.action, buttons),
        displayId = displayId,
        downTime = downTime,
        pointers = pointers,
        source = gestureSource,
    )

    private fun gestureButtonState(action: PointerAction, buttons: Int): Int =
        if (action == PointerAction.Up || action == PointerAction.Cancel || gestureSource != SOURCE_MOUSE) 0 else buttons

    private companion object {
        const val MOTION_ACTION_DOWN = 0
        const val MOTION_ACTION_UP = 1
        const val MOTION_ACTION_MOVE = 2
        const val MOTION_ACTION_CANCEL = 3
        const val MOTION_ACTION_POINTER_DOWN = 5
        const val MOTION_ACTION_POINTER_UP = 6
        const val BUTTON_PRIMARY = 1
        const val SOURCE_MOUSE = 0x00002002
        const val SOURCE_TOUCHSCREEN = 0x00001002
        const val TOOL_TYPE_FINGER = 1
        const val TOOL_TYPE_MOUSE = 3
    }
}

internal data class PointerGestureSnapshot(
    val pointers: Map<Int, ActivePointer>,
    val gestureDownTime: Long?,
    val gestureActionButton: Int,
    val gestureSource: Int,
    val gestureToolType: Int,
)

internal fun PointerGestureUpdate.canFallbackToShell(snapshot: PointerGestureSnapshot): Boolean =
    pointers.size <= 1 && snapshot.pointers.size <= 1

internal class ShellPointerFallback {
    fun inject(event: PointerControlMessage, shell: (List<String>) -> Boolean): Boolean = when (event.action) {
        PointerAction.Down -> shell(listOf("motionevent", "DOWN", event.x.toString(), event.y.toString()))
        PointerAction.Move -> shell(listOf("motionevent", "MOVE", event.x.toString(), event.y.toString()))
        PointerAction.Up -> shell(listOf("motionevent", "UP", event.x.toString(), event.y.toString()))
        PointerAction.Cancel -> shell(listOf("motionevent", "CANCEL", event.x.toString(), event.y.toString()))
    }
}
