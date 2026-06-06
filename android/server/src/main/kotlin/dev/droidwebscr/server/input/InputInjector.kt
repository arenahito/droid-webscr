package dev.droidwebscr.server.input

interface InputInjector {
    fun injectPointer(event: PointerControlMessage): InjectionResult
    fun injectKey(event: KeyControlMessage): InjectionResult
    fun injectText(text: String): InjectionResult
    fun injectSystemAction(action: SystemAction): InjectionResult
}

data class PointerControlMessage(
    val action: String,
    val pointerId: Int,
    val x: Int,
    val y: Int,
)

data class KeyControlMessage(
    val action: String,
    val keyCode: Int,
    val metaState: Int,
    val repeat: Int,
)

enum class SystemAction {
    Back,
    Home,
}

sealed interface InjectionResult {
    data object Accepted : InjectionResult
    data class Rejected(val reason: String) : InjectionResult
}
