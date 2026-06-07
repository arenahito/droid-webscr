package dev.droidwebscr.server.session

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AgentLogFilterTest {
    @Test
    fun `suppresses noisy accepted control logs`() {
        assertFalse(shouldWriteAgentLog("control:pointer:Accepted"))
        assertFalse(shouldWriteAgentLog("control:key:Accepted"))
        assertFalse(shouldWriteAgentLog("control:home:Accepted"))
        assertFalse(shouldWriteAgentLog("control:text:Accepted"))
        assertTrue(shouldWriteAgentLog("control:pointer:Rejected(input failed)"))
        assertTrue(shouldWriteAgentLog("control:rejected:Unsupported message type"))
        assertTrue(shouldWriteAgentLog("clipboard:get:Rejected(Clipboard sync is disabled by policy.)"))
        assertTrue(shouldWriteAgentLog("video:reconfigure:Accepted"))
    }
}
