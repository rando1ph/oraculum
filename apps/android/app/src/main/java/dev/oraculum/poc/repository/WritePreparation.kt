package dev.oraculum.poc.repository

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

/** Only local request construction belongs here. HTTP dispatch must occur after this function returns. */
suspend fun <T> prepareWriteRequest(prepare: suspend () -> T, rejectNotSent: suspend () -> Unit): T = try {
    prepare()
} catch (error: Exception) {
    withContext(NonCancellable) { rejectNotSent() }
    throw error
}
