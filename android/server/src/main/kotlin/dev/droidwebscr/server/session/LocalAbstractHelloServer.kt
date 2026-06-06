package dev.droidwebscr.server.session

import android.net.LocalServerSocket
import java.io.Closeable

class LocalAbstractHelloServer(
    private val socketName: String,
    private val session: HelloSession = HelloSession(),
) {
    fun serveOnce() {
        LocalServerSocket(socketName).use { server ->
            server.accept().use { socket ->
                session.serve(socket.inputStream, socket.outputStream)
            }
        }
    }
}

private inline fun <T : Closeable?, R> T.use(block: (T) -> R): R {
    var failure: Throwable? = null
    try {
        return block(this)
    } catch (throwable: Throwable) {
        failure = throwable
        throw throwable
    } finally {
        when {
            this == null -> Unit
            failure == null -> close()
            else -> {
                try {
                    close()
                } catch (closeFailure: Throwable) {
                    failure.addSuppressed(closeFailure)
                }
            }
        }
    }
}
