package dev.droidwebscr.server.lifecycle

fun interface ServerResource {
    fun release()
}

enum class ServerState {
    Created,
    Running,
    Stopped,
}

class ServerLifecycle {
    private val resources = mutableListOf<ServerResource>()
    var state: ServerState = ServerState.Created
        private set

    fun registerResource(resource: ServerResource) {
        check(state != ServerState.Stopped) { "Cannot register resources after shutdown." }
        resources += resource
    }

    fun start() {
        check(state == ServerState.Created) { "Server lifecycle can only start from Created." }
        state = ServerState.Running
    }

    fun stop() {
        if (state == ServerState.Stopped) {
            return
        }

        val firstFailure = releaseResources()
        state = ServerState.Stopped

        if (firstFailure != null) {
            throw firstFailure
        }
    }

    private fun releaseResources(): RuntimeException? {
        var firstFailure: RuntimeException? = null
        for (resource in resources.asReversed()) {
            try {
                resource.release()
            } catch (error: RuntimeException) {
                firstFailure = firstFailure ?: error
            }
        }
        resources.clear()
        return firstFailure
    }
}
