package dev.droidwebscr.server.lifecycle

import kotlin.test.Test
import kotlin.test.assertEquals

class ServerLifecycleTest {
    @Test
    fun `starts stops and releases resources in reverse order`() {
        val calls = mutableListOf<String>()
        val lifecycle = ServerLifecycle()

        lifecycle.registerResource(ServerResource { calls += "first" })
        lifecycle.registerResource(ServerResource { calls += "second" })

        lifecycle.start()
        lifecycle.stop()

        assertEquals(ServerState.Stopped, lifecycle.state)
        assertEquals(listOf("second", "first"), calls)
    }

    @Test
    fun `stop is idempotent after shutdown`() {
        var releases = 0
        val lifecycle = ServerLifecycle()
        lifecycle.registerResource(ServerResource { releases += 1 })

        lifecycle.start()
        lifecycle.stop()
        lifecycle.stop()

        assertEquals(1, releases)
        assertEquals(ServerState.Stopped, lifecycle.state)
    }
}
