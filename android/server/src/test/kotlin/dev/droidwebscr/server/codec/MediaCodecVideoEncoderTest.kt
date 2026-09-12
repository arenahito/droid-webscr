package dev.droidwebscr.server.codec

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertSame

class MediaCodecVideoEncoderTest {
    @Test
    fun `rolls back an acquired codec when startup fails`() {
        StartupFailurePoint.entries.forEach { failurePoint ->
            val codec = Any()
            val surface = Any()
            val rollbacks = mutableListOf<Pair<Any, Any?>>()

            val error = assertFailsWith<StartupFailure> {
                startOwnedCodec(
                    createCodec = { codec },
                    configureCodec = {
                        failurePoint.failAt(StartupFailurePoint.Configure)
                    },
                    createInputSurface = {
                        failurePoint.failAt(StartupFailurePoint.CreateInputSurface)
                        surface
                    },
                    startCodec = {
                        failurePoint.failAt(StartupFailurePoint.Start)
                    },
                    rollback = { acquiredCodec, acquiredSurface ->
                        rollbacks.add(acquiredCodec to acquiredSurface)
                    },
                )
            }

            assertEquals(failurePoint.name, error.message)
            assertEquals(1, rollbacks.size)
            assertSame(codec, rollbacks.single().first)
            val expectedSurface = when (failurePoint) {
                StartupFailurePoint.Configure,
                StartupFailurePoint.CreateInputSurface,
                -> null
                StartupFailurePoint.Start -> surface
            }
            assertSame(expectedSurface, rollbacks.single().second)
        }
    }

    private enum class StartupFailurePoint {
        Configure,
        CreateInputSurface,
        Start;

        fun failAt(point: StartupFailurePoint) {
            if (this == point) {
                throw StartupFailure(name)
            }
        }
    }

    private class StartupFailure(message: String) : RuntimeException(message)
}
