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
) {
    fun normalized(): DeviceMetadata {
        require(displayWidth > 0) { "Display width must be positive." }
        require(displayHeight > 0) { "Display height must be positive." }
        require(sdkInt > 0) { "SDK version must be positive." }
        return copy(
            manufacturer = manufacturer.trim(),
            model = model.trim(),
            rotation = rotation.floorMod(4),
        )
    }
}

private fun Int.floorMod(modulus: Int): Int = ((this % modulus) + modulus) % modulus
