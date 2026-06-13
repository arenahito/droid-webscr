package dev.droidwebscr.server.session

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class DisplaySizeTest {
    @Test
    fun `keeps emulator aspect ratio within encoder bounds`() {
        assertEquals(DisplaySize(860, 1920), DisplaySize(1280, 2856).fitWithin(maxWidth = 1080, maxHeight = 1920))
    }

    @Test
    fun `parses physical wm size`() {
        assertEquals(DisplaySize(720, 1606), parseWmSizeOutput("Physical size: 720x1606\n"))
    }

    @Test
    fun `parses override wm size first`() {
        val output = """
            Physical size: 1440x3120
            Override size: 720x1560
        """.trimIndent()

        assertEquals(DisplaySize(720, 1560), parseWmSizeOutput(output))
    }

    @Test
    fun `parses current logical display size from window dumpsys`() {
        val output = """
            Display: mDisplayId=0
              init=1080x2400 480dpi cur=2400x1080 app=2400x1080 rng=1080x1008-2400x2280
            Display: mDisplayId=26
              init=864x1920 320dpi cur=864x1920 app=864x1920 rng=864x816-1920x1872
        """.trimIndent()

        assertEquals(DisplaySize(2400, 1080), parseWindowDisplaysCurrentSize(output, displayId = 0))
        assertEquals(DisplaySize(864, 1920), parseWindowDisplaysCurrentSize(output, displayId = 26))
    }

    @Test
    fun `ignores invalid wm size output`() {
        assertNull(parseWmSizeOutput("Physical size: 0x1606\n"))
        assertNull(parseWmSizeOutput("Unable to get display size\n"))
    }
}
