package dev.droidwebscr.server.input

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.Closeable
import java.io.FileDescriptor
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

internal interface PhysicalTouchInputAdapter : Closeable {
    fun inject(event: PointerControlMessage): Boolean
    override fun close() = Unit
}

internal class HybridInputEventAdapter(
    private val reflected: InputEventAdapter,
    private val physicalTouch: PhysicalTouchInputAdapter?,
) : InputEventAdapter {
    private var physicalPrimaryDown: PointerControlMessage? = null
    private val physicalPointerEvents = mutableMapOf<Int, PointerControlMessage>()
    private val physicalPointers = mutableSetOf<Int>()
    private val reflectedPointers = mutableSetOf<Int>()

    override fun injectKey(event: KeyControlMessage): Boolean = reflected.injectKey(event)

    override fun injectPointer(event: PointerControlMessage): Boolean {
        val primaryDown = physicalPrimaryDown
        if (primaryDown != null) {
            if (reflectedPointers.isEmpty() && (event.pointerId in physicalPointers || event.action == PointerAction.Down)) {
                val accepted = physicalTouch?.inject(event) == true
                if (accepted) {
                    updatePhysicalState(event)
                    return true
                }
                if (event.pointerId in physicalPointers) {
                    return false
                }
            }
            if (event.pointerId == primaryDown.pointerId && reflectedPointers.isEmpty()) {
                val accepted = physicalTouch?.inject(event) == true
                if (accepted && event.action != PointerAction.Up && event.action != PointerAction.Cancel) {
                    physicalPrimaryDown = event.copy(action = PointerAction.Down)
                }
                if (accepted && (event.action == PointerAction.Up || event.action == PointerAction.Cancel)) {
                    physicalPrimaryDown = null
                }
                return accepted
            }
            if (event.action == PointerAction.Down && reflectedPointers.isEmpty()) {
                val releasedPhysicalTouch = physicalTouch?.inject(
                    primaryDown.copy(
                        action = PointerAction.Cancel,
                        buttons = 0,
                        pressure = 0f,
                    ),
                ) == true
                if (!releasedPhysicalTouch) {
                    return false
                }
                val activePhysicalEvents = physicalPointerEvents.values.sortedBy { it.pointerId }
                physicalPrimaryDown = null
                physicalPointerEvents.clear()
                physicalPointers.clear()
                for (physicalEvent in activePhysicalEvents) {
                    val accepted = reflected.injectPointer(physicalEvent)
                    if (!accepted) {
                        return false
                    }
                    reflectedPointers.add(physicalEvent.pointerId)
                }
                val secondaryAccepted = reflected.injectPointer(event)
                if (secondaryAccepted) {
                    reflectedPointers.add(event.pointerId)
                }
                return secondaryAccepted
            }
        }

        if (reflectedPointers.isNotEmpty()) {
            val accepted = reflected.injectPointer(event)
            if (accepted) {
                if (event.action == PointerAction.Down) {
                    reflectedPointers.add(event.pointerId)
                }
                if (event.action == PointerAction.Cancel) {
                    reflectedPointers.clear()
                } else if (event.action == PointerAction.Up) {
                    reflectedPointers.remove(event.pointerId)
                }
            }
            return accepted
        }

        if (event.isPhysicalPrimaryDragStart() && physicalTouch?.inject(event) == true) {
            updatePhysicalState(event)
            return true
        }
        return reflected.injectPointer(event)
    }

    override fun injectText(text: String): Boolean = reflected.injectText(text)

    override fun close() {
        physicalPrimaryDown = null
        physicalPointerEvents.clear()
        physicalPointers.clear()
        reflectedPointers.clear()
        physicalTouch?.close()
        reflected.close()
    }

    private fun updatePhysicalState(event: PointerControlMessage) {
        if (event.action == PointerAction.Cancel) {
            physicalPrimaryDown = null
            physicalPointerEvents.clear()
            physicalPointers.clear()
            return
        }
        if (event.action == PointerAction.Down) {
            physicalPointers.add(event.pointerId)
        }
        if (event.action == PointerAction.Up) {
            physicalPointers.remove(event.pointerId)
            physicalPointerEvents.remove(event.pointerId)
        }
        if (event.pointerId == 0 && event.action != PointerAction.Up) {
            physicalPrimaryDown = event.copy(action = PointerAction.Down)
        }
        if (event.action != PointerAction.Up) {
            physicalPointerEvents[event.pointerId] = event.copy(action = PointerAction.Down)
        }
        if (physicalPointers.isEmpty()) {
            physicalPrimaryDown = null
        }
    }

    private fun PointerControlMessage.isPhysicalPrimaryDragStart(): Boolean =
        action == PointerAction.Down && pointerId == 0 && buttons == BUTTON_PRIMARY

    companion object {
        fun createDefault(bounds: InputDisplayBounds): HybridInputEventAdapter {
            return HybridInputEventAdapter(
                reflected = ReflectionInputEventAdapter(),
                physicalTouch = UhidTouchInputAdapter.open(bounds),
            )
        }

        private const val BUTTON_PRIMARY = 1
    }
}

internal class UhidTouchInputAdapter(
    private val device: UhidTouchDevice,
    private val bounds: InputDisplayBounds,
) : PhysicalTouchInputAdapter {
    private val activePointers = mutableMapOf<Int, TouchReport>()

    override fun inject(event: PointerControlMessage): Boolean {
        if (event.pointerId !in 0 until UhidTouchscreenReportDescriptor.MAX_CONTACTS) {
            return false
        }
        val report = event.toTouchReport(touching = event.action != PointerAction.Up && event.action != PointerAction.Cancel)
        return when (event.action) {
            PointerAction.Down,
            PointerAction.Move,
            -> {
                val nextPointers = activePointers.toMutableMap()
                nextPointers[event.pointerId] = report
                val accepted = device.send(nextPointers.toFrame())
                if (accepted) {
                    activePointers.clear()
                    activePointers.putAll(nextPointers)
                }
                accepted
            }
            PointerAction.Up,
            PointerAction.Cancel,
            -> {
                val finalTouch = report.copy(touching = true)
                val finalPointers = activePointers.toMutableMap()
                finalPointers[event.pointerId] = finalTouch
                val finalTouchAccepted = device.send(finalPointers.toFrame())
                if (finalTouchAccepted) {
                    activePointers.clear()
                    activePointers.putAll(finalPointers)
                }
                val releasedPointerIds = if (event.action == PointerAction.Cancel) {
                    activePointers.keys.toSet()
                } else {
                    setOf(event.pointerId)
                }
                val releasePointers = activePointers.mapValues { (pointerId, activeReport) ->
                    if (pointerId in releasedPointerIds) activeReport.copy(touching = false) else activeReport
                }
                val releaseAccepted = finalTouchAccepted && device.send(
                    UhidTouchFrame(
                        contacts = releasePointers.values.sortedBy { it.contactId },
                        contactCount = (releasePointers.size - releasedPointerIds.size).coerceAtLeast(0),
                    ),
                )
                val accepted = finalTouchAccepted && releaseAccepted
                if (accepted) {
                    activePointers.keys.removeAll(releasedPointerIds)
                }
                accepted
            }
        }
    }

    override fun close() {
        val releaseFrame = UhidTouchFrame(
            contacts = activePointers.values
                .map { report -> report.copy(touching = false) }
                .sortedBy { it.contactId },
            contactCount = 0,
        )
        if (activePointers.isEmpty() || device.send(releaseFrame)) {
            activePointers.clear()
        }
        device.close()
    }

    private fun Map<Int, TouchReport>.toFrame(): UhidTouchFrame = UhidTouchFrame(
        contacts = values.sortedBy { it.contactId },
        contactCount = size,
    )

    private fun PointerControlMessage.toTouchReport(touching: Boolean): TouchReport = TouchReport(
        touching = touching,
        contactId = pointerId,
        x = x.scaleCoordinate(bounds.width),
        y = y.scaleCoordinate(bounds.height),
    )

    private fun Int.scaleCoordinate(size: Int): Int {
        if (size <= 1) {
            return 0
        }
        return ((this.toDouble() / (size - 1).toDouble()) * UhidTouchscreenReportDescriptor.LOGICAL_MAXIMUM)
            .roundToInt()
            .coerceIn(0, UhidTouchscreenReportDescriptor.LOGICAL_MAXIMUM)
    }

    companion object {
        fun open(bounds: InputDisplayBounds): UhidTouchInputAdapter? =
            UhidTouchDeviceHandle.open(UhidTouchscreenReportDescriptor.create(bounds))
                ?.let { device -> UhidTouchInputAdapter(device, bounds) }
    }
}

internal data class TouchReport(
    val touching: Boolean,
    val contactId: Int,
    val x: Int,
    val y: Int,
)

internal data class UhidTouchFrame(
    val contacts: List<TouchReport>,
    val contactCount: Int,
)

internal data class UhidTouchscreenReportDescriptor(
    val bytes: ByteArray,
    val reportLength: Int,
    val logicalMaximum: Int,
) {
    companion object {
        const val LOGICAL_MAXIMUM = 32767
        const val MAX_CONTACTS = 2

        fun create(bounds: InputDisplayBounds): UhidTouchscreenReportDescriptor {
            val max = LOGICAL_MAXIMUM
            val contactDescriptor = intArrayOf(
                0x05, 0x0d,
                0x09, 0x22,
                0xa1, 0x02,
                0x09, 0x42,
                0x09, 0x32,
                0x15, 0x00,
                0x25, 0x01,
                0x75, 0x01,
                0x95, 0x02,
                0x81, 0x02,
                0x95, 0x06,
                0x81, 0x03,
                0x09, 0x51,
                0x15, 0x00,
                0x25, 0x7f,
                0x75, 0x08,
                0x95, 0x01,
                0x81, 0x02,
                0x05, 0x01,
                0x09, 0x30,
                0x09, 0x31,
                0x16, 0x00, 0x00,
                0x26, max and 0xff, (max ushr 8) and 0xff,
                0x36, 0x00, 0x00,
                0x46, max and 0xff, (max ushr 8) and 0xff,
                0x75, 0x10,
                0x95, 0x02,
                0x81, 0x02,
                0xc0,
            )
            val descriptor = (
                intArrayOf(
                    0x05, 0x0d,
                    0x09, 0x04,
                    0xa1, 0x01,
                ) +
                    contactDescriptor +
                    contactDescriptor +
                    intArrayOf(
                        0x05, 0x0d,
                        0x09, 0x54,
                        0x15, 0x00,
                        0x25, MAX_CONTACTS,
                        0x75, 0x08,
                        0x95, 0x01,
                        0x81, 0x02,
                    ) +
                    intArrayOf(
                        0xc0,
                    )
                )
                .map { it.toByte() }
                .toByteArray()
            require(bounds.width > 0 && bounds.height > 0)
            return UhidTouchscreenReportDescriptor(
                bytes = descriptor,
                reportLength = TOUCH_CONTACT_LENGTH_BYTES * MAX_CONTACTS + TOUCH_CONTACT_COUNT_LENGTH_BYTES,
                logicalMaximum = LOGICAL_MAXIMUM,
            )
        }

        private const val TOUCH_CONTACT_LENGTH_BYTES = 6
        private const val TOUCH_CONTACT_COUNT_LENGTH_BYTES = 1
    }
}

internal interface UhidTouchDevice : Closeable {
    fun send(frame: UhidTouchFrame): Boolean
}

internal class UhidTouchDeviceHandle private constructor(
    private val fd: FileDescriptor,
) : UhidTouchDevice {
    override fun send(frame: UhidTouchFrame): Boolean {
        val buffer = ByteArray(REPORT_LENGTH_BYTES)
        for ((index, report) in frame.contacts.take(UhidTouchscreenReportDescriptor.MAX_CONTACTS).withIndex()) {
            val offset = index * TOUCH_CONTACT_LENGTH_BYTES
            buffer[offset] = if (report.touching) TOUCH_FLAGS_ACTIVE else 0
            buffer[offset + 1] = report.contactId.coerceIn(0, 127).toByte()
            buffer[offset + 2] = (report.x and 0xff).toByte()
            buffer[offset + 3] = ((report.x ushr 8) and 0xff).toByte()
            buffer[offset + 4] = (report.y and 0xff).toByte()
            buffer[offset + 5] = ((report.y ushr 8) and 0xff).toByte()
        }
        buffer[REPORT_LENGTH_BYTES - 1] = frame.contactCount.coerceIn(
            0,
            UhidTouchscreenReportDescriptor.MAX_CONTACTS,
        ).toByte()
        return writeEvent(UHID_INPUT2, buffer)
    }

    override fun close() {
        runCatching { Os.close(fd) }
    }

    private fun writeEvent(type: Int, payload: ByteArray): Boolean = runCatching {
        val event = ByteBuffer.allocate(UHID_EVENT_LENGTH_BYTES)
            .order(ByteOrder.nativeOrder())
            .putInt(type)
        if (type == UHID_INPUT2) {
            event.putShort(payload.size.toShort())
        }
        event.put(payload)
        Os.write(fd, event.array(), 0, event.position())
        true
    }.getOrDefault(false)

    companion object {
        fun open(descriptor: UhidTouchscreenReportDescriptor): UhidTouchDeviceHandle? = runCatching {
            val fd = Os.open("/dev/uhid", OsConstants.O_RDWR or OsConstants.O_CLOEXEC, 0)
            val handle = UhidTouchDeviceHandle(fd)
            if (handle.create(descriptor)) {
                handle
            } else {
                handle.close()
                null
            }
        }.getOrElse { error ->
            if (error is ErrnoException) null else null
        }

        private fun UhidTouchDeviceHandle.create(descriptor: UhidTouchscreenReportDescriptor): Boolean {
            val name = "droid-webscr-touch".encodeToByteArray()
            val request = ByteBuffer.allocate(UHID_CREATE2_FIXED_LENGTH_BYTES + descriptor.bytes.size)
                .order(ByteOrder.nativeOrder())
                .putInt(UHID_CREATE2)
            request.putPadded(name, 128)
            request.putPadded(ByteArray(0), 64)
            request.putPadded(ByteArray(0), 64)
            request.putShort(descriptor.bytes.size.toShort())
            request.putShort(BUS_VIRTUAL.toShort())
            request.putInt(0x6477)
            request.putInt(0x0001)
            request.putInt(1)
            request.putInt(0)
            request.put(descriptor.bytes)
            return writeRaw(request.array().copyOf(request.position()))
        }

        private fun UhidTouchDeviceHandle.writeRaw(payload: ByteArray): Boolean = runCatching {
            Os.write(fd, payload, 0, payload.size)
            true
        }.getOrDefault(false)

        private fun ByteBuffer.putPadded(bytes: ByteArray, length: Int): ByteBuffer {
            val count = minOf(bytes.size, length - 1)
            put(bytes, 0, count)
            repeat(length - count) { put(0) }
            return this
        }

        private const val UHID_CREATE2 = 11
        private const val UHID_INPUT2 = 12
        private const val UHID_EVENT_LENGTH_BYTES = 4380
        private const val UHID_CREATE2_FIXED_LENGTH_BYTES = 280
        private const val BUS_VIRTUAL = 0x06
        private const val TOUCH_CONTACT_LENGTH_BYTES = 6
        private const val REPORT_LENGTH_BYTES =
            TOUCH_CONTACT_LENGTH_BYTES * UhidTouchscreenReportDescriptor.MAX_CONTACTS + 1
        private const val TOUCH_FLAGS_ACTIVE: Byte = 0x03
    }
}
