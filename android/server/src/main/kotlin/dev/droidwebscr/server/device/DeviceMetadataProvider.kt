package dev.droidwebscr.server.device

interface DeviceMetadataProvider {
    fun snapshot(): DeviceMetadata
}

data class DeviceMetadata(
    val manufacturer: String,
    val model: String,
    val sdkInt: Int,
    val displayWidth: Int,
    val displayHeight: Int,
    val rotation: Int,
)
