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

/**
 * The signal must run immediately before the one-shot business request is enqueued, after auth
 * and local validation. Once signalled, every failure remains unknown unless its receipt says otherwise.
 */
suspend fun <T> dispatchWriteRequest(
    dispatch: suspend (markDispatched: () -> Unit) -> T,
    rejectNotSent: suspend () -> Unit,
): T {
    var dispatched = false
    return try {
        dispatch { dispatched = true }
    } catch (error: Exception) {
        if (!dispatched) withContext(NonCancellable) { rejectNotSent() }
        throw error
    }
}
