package dev.droidwebscr.server

import dev.droidwebscr.server.lifecycle.ServerLifecycle
import dev.droidwebscr.server.log.StdoutServerLogger
import dev.droidwebscr.server.session.LocalAbstractHelloServer
import dev.droidwebscr.server.session.ProductVerificationServer
import java.io.PrintStream
import kotlin.system.exitProcess

fun main(args: Array<String>) {
    val exitCode = runServerMain(
        args = args,
        stderr = System.err,
        serveHelloOnce = { socketName -> LocalAbstractHelloServer(socketName).serveOnce() },
        serveProductVerificationOnce = { socketName -> ProductVerificationServer(socketName).serveOnce() },
        runLifecycle = {
            val logger = StdoutServerLogger()
            val lifecycle = ServerLifecycle()
            lifecycle.start()
            logger.info("droid-webscr Android server started", mapOf("state" to lifecycle.state.name))
            lifecycle.stop()
        },
    )
    if (exitCode != 0) {
        exitProcess(exitCode)
    }
}

internal fun runServerMain(
    args: Array<String>,
    stderr: PrintStream,
    serveHelloOnce: (String) -> Unit,
    serveProductVerificationOnce: (String) -> Unit,
    runLifecycle: () -> Unit,
): Int {
    return runCatching {
        when (args.firstOrNull()) {
            "--hello-once" -> serveHelloOnce(args.getOrElse(1) { "droid-webscr" })
            "--verify-once" -> serveProductVerificationOnce(args.getOrElse(1) { "droid-webscr" })
            else -> runLifecycle()
        }
    }.fold(
        onSuccess = { 0 },
        onFailure = { error ->
            stderr.println("droid-webscr Android server failed: ${error.message ?: error::class.qualifiedName}")
            error.printStackTrace(stderr)
            1
        },
    )
}
