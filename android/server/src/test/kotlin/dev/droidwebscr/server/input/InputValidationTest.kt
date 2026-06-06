package dev.droidwebscr.server.input

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class InputValidationTest {
    @Test
    fun `validates pointer bounds and pointer count`() {
        val display = InputDisplayBounds(width = 1080, height = 2400, maxPointers = 2)
        val pointer = PointerControlMessage(
            action = PointerAction.Down,
            pointerId = 1,
            x = 1079,
            y = 2399,
            pressure = 1f,
            buttons = 0,
            displayId = 0,
        ).validated(display)

        assertEquals(PointerAction.Down, pointer.action)
        assertFailsWith<IllegalArgumentException> { pointer.copy(pointerId = 2).validated(display) }
        assertFailsWith<IllegalArgumentException> { pointer.copy(x = 1080).validated(display) }
        assertFailsWith<IllegalArgumentException> { pointer.copy(y = -1).validated(display) }
    }

    @Test
    fun `validates keycode range text length and unsupported system actions`() {
        val key = KeyControlMessage(KeyAction.Down, keyCode = 4, metaState = 0, repeat = 0).validated()
        assertEquals(4, key.keyCode)

        assertFailsWith<IllegalArgumentException> {
            KeyControlMessage(KeyAction.Down, keyCode = 0, metaState = 0, repeat = 0).validated()
        }
        assertFailsWith<IllegalArgumentException> {
            TextControlMessage("x".repeat(1025)).validated()
        }
        assertEquals(SystemAction.Back, SystemAction.requireSupported("back"))
        assertEquals(SystemAction.Overview, SystemAction.requireSupported("overview"))
        assertEquals(SystemAction.VolumeUp, SystemAction.requireSupported("volume-up"))
        assertEquals(SystemAction.Power, SystemAction.requireSupported("power"))
        assertFailsWith<IllegalArgumentException> {
            SystemAction.requireSupported("recents")
        }
    }

    @Test
    fun `shell injector emits input events through adapter`() {
        val adapter = RecordingInputEventAdapter()
        val injector = ShellInputInjector(adapter, InputDisplayBounds(1080, 2400))

        assertEquals(InjectionResult.Accepted, injector.injectSystemAction(SystemAction.Home))
        assertEquals(listOf("key:Down:3", "key:Up:3"), adapter.events)
    }

    @Test
    fun `shell injector maps extended system actions to Android keycodes`() {
        val adapter = RecordingInputEventAdapter()
        val injector = ShellInputInjector(adapter, InputDisplayBounds(1080, 2400))

        assertEquals(InjectionResult.Accepted, injector.injectSystemAction(SystemAction.Overview))
        assertEquals(InjectionResult.Accepted, injector.injectSystemAction(SystemAction.VolumeUp))
        assertEquals(InjectionResult.Accepted, injector.injectSystemAction(SystemAction.Power))
        assertEquals(
            listOf("key:Down:187", "key:Up:187", "key:Down:24", "key:Up:24", "key:Down:26", "key:Up:26"),
            adapter.events,
        )
    }

    private class RecordingInputEventAdapter : InputEventAdapter {
        val events = mutableListOf<String>()

        override fun injectKey(event: KeyControlMessage): Boolean {
            events.add("key:${event.action}:${event.keyCode}")
            return true
        }

        override fun injectPointer(event: PointerControlMessage): Boolean {
            events.add("pointer:${event.action}:${event.x}:${event.y}")
            return true
        }

        override fun injectText(text: String): Boolean {
            events.add("text:$text")
            return true
        }
    }
}
