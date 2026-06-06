package dev.droidwebscr.server

import dev.droidwebscr.server.lifecycle.ServerLifecycle
import dev.droidwebscr.server.log.StdoutServerLogger

fun main() {
    val logger = StdoutServerLogger()
    val lifecycle = ServerLifecycle()
    lifecycle.start()
    logger.info("droid-webscr Android server started", mapOf("state" to lifecycle.state.name))
    lifecycle.stop()
}
