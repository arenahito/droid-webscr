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

    @Test
    fun `pointer gesture clock keeps the original down time until the gesture ends`() {
        val state = PointerGestureState()
        val pointer = PointerControlMessage(PointerAction.Down, pointerId = 3, x = 10, y = 20)

        assertEquals(100L, state.update(pointer, eventTime = 100L).downTime)
        assertEquals(100L, state.update(pointer.copy(action = PointerAction.Move), eventTime = 120L).downTime)
        assertEquals(100L, state.update(pointer.copy(action = PointerAction.Up), eventTime = 140L).downTime)
        assertEquals(200L, state.update(pointer.copy(action = PointerAction.Down), eventTime = 200L).downTime)
    }

    @Test
    fun `pointer gesture state tracks multi touch actions and active pointer coordinates`() {
        val state = PointerGestureState()
        val firstDown = PointerControlMessage(
            PointerAction.Down,
            pointerId = 0,
            x = 10,
            y = 20,
            buttons = 1,
            displayId = 2,
        )
        val secondDown = PointerControlMessage(PointerAction.Down, pointerId = 1, x = 90, y = 180)

        val firstPointer = state.update(firstDown, eventTime = 100L)
        assertEquals(0, firstPointer.action)
        assertEquals(0, firstPointer.buttonState)
        assertEquals(2, firstPointer.displayId)
        assertEquals(0, state.activePointers().single().id)
        assertEquals(0, state.activePointers().single().index)
        assertEquals(10, state.activePointers().single().x)
        assertEquals(20, state.activePointers().single().y)

        val secondPointer = state.update(secondDown, eventTime = 120L)
        assertEquals(5 or (1 shl 8), secondPointer.action)
        assertEquals(100L, secondPointer.downTime)
        assertEquals(listOf(0, 1), state.activePointers().map { it.id })

        val move = state.update(firstDown.copy(action = PointerAction.Move, x = 30, y = 40), eventTime = 140L)
        assertEquals(2, move.action)
        assertEquals(listOf(30, 90), state.activePointers().map { it.x })

        val firstUp = state.update(firstDown.copy(action = PointerAction.Up, x = 35, y = 45), eventTime = 160L)
        assertEquals(6, firstUp.action and 0xff)
        assertEquals(0, firstUp.action shr 8)
        assertEquals(35, firstUp.pointers.first { it.id == 0 }.x)
        assertEquals(45, firstUp.pointers.first { it.id == 0 }.y)
        assertEquals(listOf(1), state.activePointers().map { it.id })

        val finalUp = state.update(secondDown.copy(action = PointerAction.Up, x = 95, y = 185), eventTime = 180L)
        assertEquals(1, finalUp.action)
        assertEquals(0, finalUp.buttonState)
        assertEquals(95, finalUp.pointers.single().x)
        assertEquals(185, finalUp.pointers.single().y)
        assertEquals(emptyList(), state.activePointers().map { it.id })
    }

    @Test
    fun `pointer gesture state converts primary desktop drags to touch gestures`() {
        val state = PointerGestureState()
        val down = PointerControlMessage(
            PointerAction.Down,
            pointerId = 0,
            x = 100,
            y = 200,
            buttons = 1,
        )

        val first = state.update(down, eventTime = 100L)
        val move = state.update(down.copy(action = PointerAction.Move, x = 300), eventTime = 120L)
        val up = state.update(down.copy(action = PointerAction.Up, x = 500, buttons = 0), eventTime = 140L)

        assertEquals(0x00001002, first.source)
        assertEquals(0, first.actionButton)
        assertEquals(0, first.buttonState)
        assertEquals(1, first.pointers.single().toolType)
        assertEquals(0x00001002, move.source)
        assertEquals(0, move.actionButton)
        assertEquals(0, move.buttonState)
        assertEquals(1, move.pointers.single().toolType)
        assertEquals(0x00001002, up.source)
        assertEquals(0, up.actionButton)
        assertEquals(0, up.buttonState)
        assertEquals(1, up.pointers.single().toolType)
    }

    @Test
    fun `pointer gesture state uses touchscreen source for buttonless touch gestures`() {
        val state = PointerGestureState()
        val down = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200, buttons = 0)

        val first = state.update(down, eventTime = 100L)
        val move = state.update(down.copy(action = PointerAction.Move, x = 120), eventTime = 120L)

        assertEquals(0x00001002, first.source)
        assertEquals(0, first.actionButton)
        assertEquals(1, first.pointers.single().toolType)
        assertEquals(0x00001002, move.source)
        assertEquals(0, move.actionButton)
        assertEquals(1, move.pointers.single().toolType)
    }

    @Test
    fun `pointer gesture state preserves mouse source for non primary buttons`() {
        val state = PointerGestureState()
        val down = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200, buttons = 2)

        val first = state.update(down, eventTime = 100L)
        val move = state.update(down.copy(action = PointerAction.Move, x = 120), eventTime = 120L)

        assertEquals(0x00002002, first.source)
        assertEquals(2, first.actionButton)
        assertEquals(2, first.buttonState)
        assertEquals(3, first.pointers.single().toolType)
        assertEquals(0x00002002, move.source)
        assertEquals(2, move.actionButton)
        assertEquals(2, move.buttonState)
        assertEquals(3, move.pointers.single().toolType)
    }

    @Test
    fun `pointer event clock spaces compressed drag moves while preserving real elapsed time`() {
        val clock = PointerEventClock(minimumMoveIntervalMs = 8L)

        assertEquals(100L, clock.next(PointerAction.Down, now = 100L))
        assertEquals(108L, clock.next(PointerAction.Move, now = 100L))
        assertEquals(116L, clock.next(PointerAction.Move, now = 101L))
        assertEquals(140L, clock.next(PointerAction.Move, now = 140L))
        assertEquals(148L, clock.next(PointerAction.Up, now = 140L))
        assertEquals(180L, clock.next(PointerAction.Down, now = 180L))
    }

    @Test
    fun `pointer gesture state can restore a failed transition`() {
        val state = PointerGestureState()
        val down = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200)
        val failedSecondDown = PointerControlMessage(PointerAction.Down, pointerId = 1, x = 300, y = 400)

        state.update(down, eventTime = 100L)
        val snapshot = state.snapshot()
        state.update(failedSecondDown, eventTime = 120L)
        state.restore(snapshot)

        assertEquals(listOf(0), state.activePointers().map { it.id })
        assertEquals(100, state.activePointers().single().x)
        val retry = state.update(failedSecondDown, eventTime = 140L)
        assertEquals(5 or (1 shl 8), retry.action)
        assertEquals(listOf(0, 1), state.activePointers().map { it.id })
    }

    @Test
    fun `pointer gesture state clears every active pointer after cancel`() {
        val state = PointerGestureState()
        val first = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200)
        val second = PointerControlMessage(PointerAction.Down, pointerId = 1, x = 300, y = 400)
        val cancelSecond = second.copy(action = PointerAction.Cancel)

        state.update(first, eventTime = 100L)
        state.update(second, eventTime = 120L)
        val cancel = state.update(cancelSecond, eventTime = 140L)

        assertEquals(3, cancel.action)
        assertEquals(emptyList(), state.activePointers())
        val next = state.update(first.copy(x = 500, y = 600), eventTime = 180L)
        assertEquals(0, next.action)
        assertEquals(180L, next.downTime)
        assertEquals(listOf(0), state.activePointers().map { it.id })
    }

    @Test
    fun `shell fallback is allowed only while reflection tracks a single pointer gesture`() {
        val singleBefore = PointerGestureSnapshot(
            pointers = emptyMap(),
            gestureDownTime = null,
            gestureActionButton = 0,
            gestureSource = 0x00001002,
            gestureToolType = 1,
        )
        val singleGesture = PointerGestureUpdate(
            action = 0,
            actionButton = 0,
            buttonState = 0,
            displayId = 0,
            downTime = 100L,
            pointers = listOf(ActivePointer(0, 0, 10, 20, 1f, 1)),
            source = 0x00001002,
        )
        val multiBefore = singleBefore.copy(
            pointers = mapOf(0 to ActivePointer(0, 0, 10, 20, 1f, 1)),
            gestureDownTime = 100L,
        )
        val multiGesture = singleGesture.copy(
            action = 5 or (1 shl 8),
            pointers = listOf(
                ActivePointer(0, 0, 10, 20, 1f, 1),
                ActivePointer(1, 1, 30, 40, 1f, 1),
            ),
        )

        assertEquals(true, singleGesture.canFallbackToShell(singleBefore))
        assertEquals(false, multiGesture.canFallbackToShell(multiBefore))
    }

    @Test
    fun `shell pointer fallback emits drag motion events instead of swipe commands`() {
        val fallback = ShellPointerFallback()
        val calls = mutableListOf<List<String>>()
        val pointer = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 10, y = 20)

        fallback.inject(pointer) { args -> calls.add(args); true }
        fallback.inject(pointer.copy(action = PointerAction.Move, x = 30, y = 40)) { args -> calls.add(args); true }
        fallback.inject(pointer.copy(action = PointerAction.Up, x = 50, y = 60)) { args -> calls.add(args); true }

        assertEquals(
            listOf(
                listOf("motionevent", "DOWN", "10", "20"),
                listOf("motionevent", "MOVE", "30", "40"),
                listOf("motionevent", "UP", "50", "60"),
            ),
            calls,
        )
    }

    @Test
    fun `hybrid adapter uses physical touch for primary pointer gestures`() {
        val physical = RecordingPhysicalTouchInputAdapter()
        val reflected = RecordingInputEventAdapter()
        val adapter = HybridInputEventAdapter(reflected, physical)
        val pointer = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200, buttons = 1)

        assertEquals(true, adapter.injectPointer(pointer))

        assertEquals(listOf("physical:Down:0:100:200:1"), physical.events)
        assertEquals(emptyList(), reflected.events)
    }

    @Test
    fun `hybrid adapter falls back to reflected input when physical touch rejects`() {
        val physical = RecordingPhysicalTouchInputAdapter(accepted = false)
        val reflected = RecordingInputEventAdapter()
        val adapter = HybridInputEventAdapter(reflected, physical)
        val pointer = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200, buttons = 1)

        assertEquals(true, adapter.injectPointer(pointer))

        assertEquals(listOf("physical:Down:0:100:200:1"), physical.events)
        assertEquals(listOf("pointer:Down:100:200"), reflected.events)
    }

    @Test
    fun `hybrid adapter keeps non primary buttons on reflected input`() {
        val physical = RecordingPhysicalTouchInputAdapter()
        val reflected = RecordingInputEventAdapter()
        val adapter = HybridInputEventAdapter(reflected, physical)
        val pointer = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200, buttons = 2)

        assertEquals(true, adapter.injectPointer(pointer))

        assertEquals(emptyList(), physical.events)
        assertEquals(listOf("pointer:Down:100:200"), reflected.events)
    }

    @Test
    fun `hybrid adapter keeps buttonless touch gestures on reflected input for multi touch continuity`() {
        val physical = RecordingPhysicalTouchInputAdapter()
        val reflected = RecordingInputEventAdapter()
        val adapter = HybridInputEventAdapter(reflected, physical)
        val pointer = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200, buttons = 0)

        assertEquals(true, adapter.injectPointer(pointer))

        assertEquals(emptyList(), physical.events)
        assertEquals(listOf("pointer:Down:100:200"), reflected.events)
    }

    @Test
    fun `hybrid adapter keeps accepted multi touch gestures on physical input`() {
        val physical = RecordingPhysicalTouchInputAdapter()
        val reflected = RecordingInputEventAdapter()
        val adapter = HybridInputEventAdapter(reflected, physical)
        val first = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200, buttons = 1)
        val second = PointerControlMessage(PointerAction.Down, pointerId = 1, x = 300, y = 400, buttons = 1)

        assertEquals(true, adapter.injectPointer(first))
        assertEquals(true, adapter.injectPointer(second))

        assertEquals(
            listOf("physical:Down:0:100:200:1", "physical:Down:1:300:400:1"),
            physical.events,
        )
        assertEquals(emptyList(), reflected.events)
    }

    @Test
    fun `hybrid adapter moves a physical drag to reflected input when physical multi touch is rejected`() {
        val physical = RecordingPhysicalTouchInputAdapter(acceptedEvents = listOf(true, false, true))
        val reflected = RecordingInputEventAdapter()
        val adapter = HybridInputEventAdapter(reflected, physical)
        val first = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200, buttons = 1)
        val second = PointerControlMessage(PointerAction.Down, pointerId = 1, x = 300, y = 400, buttons = 1)

        assertEquals(true, adapter.injectPointer(first))
        assertEquals(true, adapter.injectPointer(second))

        assertEquals(
            listOf(
                "physical:Down:0:100:200:1",
                "physical:Down:1:300:400:1",
                "physical:Cancel:0:100:200:0",
            ),
            physical.events,
        )
        assertEquals(listOf("pointer:Down:100:200", "pointer:Down:300:400"), reflected.events)
    }

    @Test
    fun `hybrid adapter restores the latest physical primary position when multi touch starts`() {
        val physical = RecordingPhysicalTouchInputAdapter(acceptedEvents = listOf(true, true, false, true))
        val reflected = RecordingInputEventAdapter()
        val adapter = HybridInputEventAdapter(reflected, physical)
        val first = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200, buttons = 1)
        val moved = PointerControlMessage(PointerAction.Move, pointerId = 0, x = 180, y = 260, buttons = 1)
        val second = PointerControlMessage(PointerAction.Down, pointerId = 1, x = 300, y = 400, buttons = 1)

        adapter.injectPointer(first)
        adapter.injectPointer(moved)
        adapter.injectPointer(second)

        assertEquals(
            listOf(
                "physical:Down:0:100:200:1",
                "physical:Move:0:180:260:1",
                "physical:Down:1:300:400:1",
                "physical:Cancel:0:180:260:0",
            ),
            physical.events,
        )
        assertEquals(listOf("pointer:Down:180:260", "pointer:Down:300:400"), reflected.events)
    }

    @Test
    fun `hybrid adapter keeps physical state when primary release fails`() {
        val physical = RecordingPhysicalTouchInputAdapter(acceptedEvents = listOf(true, false, true))
        val reflected = RecordingInputEventAdapter()
        val adapter = HybridInputEventAdapter(reflected, physical)
        val first = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200, buttons = 1)
        val release = PointerControlMessage(PointerAction.Up, pointerId = 0, x = 200, y = 300, buttons = 0)
        val moveAfterFailedRelease =
            PointerControlMessage(PointerAction.Move, pointerId = 0, x = 240, y = 340, buttons = 1)

        assertEquals(true, adapter.injectPointer(first))
        assertEquals(false, adapter.injectPointer(release))
        assertEquals(true, adapter.injectPointer(moveAfterFailedRelease))

        assertEquals(
            listOf("physical:Down:0:100:200:1", "physical:Up:0:200:300:0", "physical:Move:0:240:340:1"),
            physical.events,
        )
        assertEquals(emptyList(), reflected.events)
    }

    @Test
    fun `hybrid adapter tracks only successfully reflected pointers after handoff`() {
        val physical = RecordingPhysicalTouchInputAdapter(acceptedEvents = listOf(true, false, true))
        val reflected = RecordingInputEventAdapter(acceptedEvents = listOf(true, false, true))
        val adapter = HybridInputEventAdapter(reflected, physical)
        val first = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200, buttons = 1)
        val second = PointerControlMessage(PointerAction.Down, pointerId = 1, x = 300, y = 400, buttons = 1)
        val secondRetry = second.copy(x = 320, y = 420)

        assertEquals(true, adapter.injectPointer(first))
        assertEquals(false, adapter.injectPointer(second))
        assertEquals(true, adapter.injectPointer(secondRetry))

        assertEquals(
            listOf("pointer:Down:100:200", "pointer:Down:300:400", "pointer:Down:320:420"),
            reflected.events,
        )
    }

    @Test
    fun `hybrid adapter replays every active physical contact when handoff follows a rejected contact`() {
        val physical = RecordingPhysicalTouchInputAdapter(acceptedEvents = listOf(true, true, false, true))
        val reflected = RecordingInputEventAdapter()
        val adapter = HybridInputEventAdapter(reflected, physical)
        val first = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200, buttons = 1)
        val second = PointerControlMessage(PointerAction.Down, pointerId = 1, x = 300, y = 400, buttons = 1)
        val third = PointerControlMessage(PointerAction.Down, pointerId = 2, x = 500, y = 600, buttons = 1)

        assertEquals(true, adapter.injectPointer(first))
        assertEquals(true, adapter.injectPointer(second))
        assertEquals(true, adapter.injectPointer(third))

        assertEquals(
            listOf(
                "physical:Down:0:100:200:1",
                "physical:Down:1:300:400:1",
                "physical:Down:2:500:600:1",
                "physical:Cancel:0:100:200:0",
            ),
            physical.events,
        )
        assertEquals(
            listOf("pointer:Down:100:200", "pointer:Down:300:400", "pointer:Down:500:600"),
            reflected.events,
        )
    }

    @Test
    fun `hybrid adapter clears reflected handoff state after cancel`() {
        val physical = RecordingPhysicalTouchInputAdapter(acceptedEvents = listOf(true, false, true, true))
        val reflected = RecordingInputEventAdapter()
        val adapter = HybridInputEventAdapter(reflected, physical)
        val first = PointerControlMessage(PointerAction.Down, pointerId = 0, x = 100, y = 200, buttons = 1)
        val second = PointerControlMessage(PointerAction.Down, pointerId = 1, x = 300, y = 400, buttons = 1)
        val cancelSecond = second.copy(action = PointerAction.Cancel, buttons = 0, pressure = 0f)
        val nextFirst = first.copy(x = 500, y = 600)

        assertEquals(true, adapter.injectPointer(first))
        assertEquals(true, adapter.injectPointer(second))
        assertEquals(true, adapter.injectPointer(cancelSecond))
        assertEquals(true, adapter.injectPointer(nextFirst))

        assertEquals(
            listOf(
                "physical:Down:0:100:200:1",
                "physical:Down:1:300:400:1",
                "physical:Cancel:0:100:200:0",
                "physical:Down:0:500:600:1",
            ),
            physical.events,
        )
        assertEquals(
            listOf("pointer:Down:100:200", "pointer:Down:300:400", "pointer:Cancel:300:400"),
            reflected.events,
        )
    }

    @Test
    fun `uhid touch input writes absolute reports for drag lifecycle`() {
        val device = RecordingUhidTouchDevice()
        val input = UhidTouchInputAdapter(device, InputDisplayBounds(width = 1080, height = 2400))

        assertEquals(true, input.inject(PointerControlMessage(PointerAction.Down, pointerId = 0, x = 0, y = 0)))
        assertEquals(true, input.inject(PointerControlMessage(PointerAction.Move, pointerId = 0, x = 540, y = 1200)))
        assertEquals(true, input.inject(PointerControlMessage(PointerAction.Up, pointerId = 0, x = 1079, y = 2399)))

        assertEquals(
            listOf(
                TouchReport(touching = true, contactId = 0, x = 0, y = 0),
                TouchReport(touching = true, contactId = 0, x = 16399, y = 16390),
                TouchReport(touching = true, contactId = 0, x = 32767, y = 32767),
                TouchReport(touching = false, contactId = 0, x = 32767, y = 32767),
            ),
            device.reports,
        )
    }

    @Test
    fun `uhid touch input writes combined reports for two active contacts`() {
        val device = RecordingUhidTouchDevice()
        val input = UhidTouchInputAdapter(device, InputDisplayBounds(width = 1080, height = 2400))

        assertEquals(true, input.inject(PointerControlMessage(PointerAction.Down, pointerId = 0, x = 0, y = 0)))
        assertEquals(true, input.inject(PointerControlMessage(PointerAction.Down, pointerId = 1, x = 1079, y = 2399)))
        assertEquals(true, input.inject(PointerControlMessage(PointerAction.Up, pointerId = 1, x = 1079, y = 2399)))

        assertEquals(
            listOf(
                UhidTouchFrame(listOf(TouchReport(touching = true, contactId = 0, x = 0, y = 0)), contactCount = 1),
                UhidTouchFrame(
                    listOf(
                        TouchReport(touching = true, contactId = 0, x = 0, y = 0),
                        TouchReport(touching = true, contactId = 1, x = 32767, y = 32767),
                    ),
                    contactCount = 2,
                ),
                UhidTouchFrame(
                    listOf(
                        TouchReport(touching = true, contactId = 0, x = 0, y = 0),
                        TouchReport(touching = true, contactId = 1, x = 32767, y = 32767),
                    ),
                    contactCount = 2,
                ),
                UhidTouchFrame(
                    listOf(
                        TouchReport(touching = true, contactId = 0, x = 0, y = 0),
                        TouchReport(touching = false, contactId = 1, x = 32767, y = 32767),
                    ),
                    contactCount = 1,
                ),
            ),
            device.frames,
        )
    }

    @Test
    fun `uhid touch input releases every active contact after cancel`() {
        val device = RecordingUhidTouchDevice()
        val input = UhidTouchInputAdapter(device, InputDisplayBounds(width = 1080, height = 2400))

        assertEquals(true, input.inject(PointerControlMessage(PointerAction.Down, pointerId = 0, x = 0, y = 0)))
        assertEquals(true, input.inject(PointerControlMessage(PointerAction.Down, pointerId = 1, x = 1079, y = 2399)))
        assertEquals(true, input.inject(PointerControlMessage(PointerAction.Cancel, pointerId = 1, x = 1079, y = 2399)))
        input.close()

        assertEquals(
            listOf(
                UhidTouchFrame(listOf(TouchReport(touching = true, contactId = 0, x = 0, y = 0)), contactCount = 1),
                UhidTouchFrame(
                    listOf(
                        TouchReport(touching = true, contactId = 0, x = 0, y = 0),
                        TouchReport(touching = true, contactId = 1, x = 32767, y = 32767),
                    ),
                    contactCount = 2,
                ),
                UhidTouchFrame(
                    listOf(
                        TouchReport(touching = true, contactId = 0, x = 0, y = 0),
                        TouchReport(touching = true, contactId = 1, x = 32767, y = 32767),
                    ),
                    contactCount = 2,
                ),
                UhidTouchFrame(
                    listOf(
                        TouchReport(touching = false, contactId = 0, x = 0, y = 0),
                        TouchReport(touching = false, contactId = 1, x = 32767, y = 32767),
                    ),
                    contactCount = 0,
                ),
            ),
            device.frames,
        )
    }

    @Test
    fun `uhid touch descriptor is sized to the mirrored display bounds`() {
        val descriptor = UhidTouchscreenReportDescriptor.create(InputDisplayBounds(width = 1080, height = 2400))

        assertEquals(32767, descriptor.logicalMaximum)
        assertEquals(13, descriptor.reportLength)
        assertEquals(true, descriptor.bytes.isNotEmpty())
    }

    @Test
    fun `uhid touch input releases active touch before close`() {
        val device = RecordingUhidTouchDevice()
        val input = UhidTouchInputAdapter(device, InputDisplayBounds(width = 1080, height = 2400))

        input.inject(PointerControlMessage(PointerAction.Down, pointerId = 0, x = 540, y = 1200))
        input.close()

        assertEquals(
            listOf(
                TouchReport(touching = true, contactId = 0, x = 16399, y = 16390),
                TouchReport(touching = false, contactId = 0, x = 16399, y = 16390),
            ),
            device.reports,
        )
    }

    @Test
    fun `uhid touch input keeps the latest accepted active touch when release fails`() {
        val device = RecordingUhidTouchDevice(acceptedReports = listOf(true, true, false, true))
        val input = UhidTouchInputAdapter(device, InputDisplayBounds(width = 1080, height = 2400))

        assertEquals(true, input.inject(PointerControlMessage(PointerAction.Down, pointerId = 0, x = 540, y = 1200)))
        assertEquals(false, input.inject(PointerControlMessage(PointerAction.Up, pointerId = 0, x = 1079, y = 2399)))
        input.close()

        assertEquals(
            listOf(
                TouchReport(touching = true, contactId = 0, x = 16399, y = 16390),
                TouchReport(touching = true, contactId = 0, x = 32767, y = 32767),
                TouchReport(touching = false, contactId = 0, x = 32767, y = 32767),
                TouchReport(touching = false, contactId = 0, x = 32767, y = 32767),
            ),
            device.reports,
        )
    }

    @Test
    fun `uhid touch input does not track active touch when down send fails`() {
        val device = RecordingUhidTouchDevice(acceptedReports = listOf(false))
        val input = UhidTouchInputAdapter(device, InputDisplayBounds(width = 1080, height = 2400))

        assertEquals(false, input.inject(PointerControlMessage(PointerAction.Down, pointerId = 0, x = 540, y = 1200)))
        input.close()

        assertEquals(
            listOf(TouchReport(touching = true, contactId = 0, x = 16399, y = 16390)),
            device.reports,
        )
    }

    private class RecordingInputEventAdapter(
        private val acceptedEvents: List<Boolean> = emptyList(),
    ) : InputEventAdapter {
        val events = mutableListOf<String>()

        override fun injectKey(event: KeyControlMessage): Boolean {
            events.add("key:${event.action}:${event.keyCode}")
            return acceptedEvents.getOrNull(events.lastIndex) ?: true
        }

        override fun injectPointer(event: PointerControlMessage): Boolean {
            events.add("pointer:${event.action}:${event.x}:${event.y}")
            return acceptedEvents.getOrNull(events.lastIndex) ?: true
        }

        override fun injectText(text: String): Boolean {
            events.add("text:$text")
            return acceptedEvents.getOrNull(events.lastIndex) ?: true
        }
    }

    private class RecordingPhysicalTouchInputAdapter(
        private val accepted: Boolean = true,
        private val acceptedEvents: List<Boolean> = emptyList(),
    ) : PhysicalTouchInputAdapter {
        val events = mutableListOf<String>()

        override fun inject(event: PointerControlMessage): Boolean {
            events.add("physical:${event.action}:${event.pointerId}:${event.x}:${event.y}:${event.buttons}")
            return acceptedEvents.getOrNull(events.lastIndex) ?: accepted
        }
    }

    private class RecordingUhidTouchDevice(
        private val acceptedReports: List<Boolean> = emptyList(),
    ) : UhidTouchDevice {
        val frames = mutableListOf<UhidTouchFrame>()
        val reports = mutableListOf<TouchReport>()

        override fun send(frame: UhidTouchFrame): Boolean {
            frames.add(frame)
            reports.addAll(frame.contacts)
            return acceptedReports.getOrNull(frames.lastIndex) ?: true
        }

        override fun close() = Unit
    }
}
