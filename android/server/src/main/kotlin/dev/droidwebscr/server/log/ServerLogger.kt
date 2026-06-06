package dev.droidwebscr.server.log

interface ServerLogger {
    fun debug(message: String, context: Map<String, Any?> = emptyMap())
    fun error(message: String, context: Map<String, Any?> = emptyMap())
    fun info(message: String, context: Map<String, Any?> = emptyMap())
    fun warn(message: String, context: Map<String, Any?> = emptyMap())
}

class StdoutServerLogger : ServerLogger {
    override fun debug(message: String, context: Map<String, Any?>) = write("debug", message, context)
    override fun error(message: String, context: Map<String, Any?>) = write("error", message, context)
    override fun info(message: String, context: Map<String, Any?>) = write("info", message, context)
    override fun warn(message: String, context: Map<String, Any?>) = write("warn", message, context)

    private fun write(level: String, message: String, context: Map<String, Any?>) {
        println("$level $message ${context.entries.joinToString(prefix = "{", postfix = "}")}")
    }
}
