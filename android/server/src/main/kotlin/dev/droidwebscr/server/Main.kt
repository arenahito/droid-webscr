package dev.droidwebscr.server

import dev.droidwebscr.server.lifecycle.ServerLifecycle
import dev.droidwebscr.server.log.StdoutServerLogger
import dev.droidwebscr.server.session.LocalAbstractHelloServer
import dev.droidwebscr.server.session.ProductVerificationServer

fun main(args: Array<String>) {
    if (args.firstOrNull() == "--hello-once") {
        LocalAbstractHelloServer(args.getOrElse(1) { "droid-webscr" }).serveOnce()
        return
    }
    if (args.firstOrNull() == "--verify-once") {
        ProductVerificationServer(args.getOrElse(1) { "droid-webscr" }).serveOnce()
        return
    }

    val logger = StdoutServerLogger()
    val lifecycle = ServerLifecycle()
    lifecycle.start()
    logger.info("droid-webscr Android server started", mapOf("state" to lifecycle.state.name))
    lifecycle.stop()
}
