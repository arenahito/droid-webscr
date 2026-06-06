package dev.droidwebscr.server.device

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class DeviceMetadataTest {
    @Test
    fun `normalizes display metadata to positive dimensions and canonical rotation`() {
        val metadata = DeviceMetadata(
            manufacturer = " Google ",
            model = " sdk_gphone ",
            sdkInt = 35,
            displayWidth = 1080,
            displayHeight = 2400,
            rotation = 5,
        ).normalized()

        assertEquals("Google", metadata.manufacturer)
        assertEquals("sdk_gphone", metadata.model)
        assertEquals(1080, metadata.displayWidth)
        assertEquals(2400, metadata.displayHeight)
        assertEquals(1, metadata.rotation)
    }

    @Test
    fun `rejects invalid display dimensions`() {
        assertFailsWith<IllegalArgumentException> {
            DeviceMetadata(
                manufacturer = "Google",
                model = "sdk",
                sdkInt = 35,
                displayWidth = 0,
                displayHeight = 2400,
                rotation = 0,
            ).normalized()
        }
    }
}
