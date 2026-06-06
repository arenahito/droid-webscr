package dev.droidwebscr.server.transport

import dev.droidwebscr.server.protocol.Frame

interface DroidTransport {
    fun readFrame(): Frame?
    fun writeFrame(frame: Frame)
    fun close()
}
