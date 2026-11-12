package dev.oraculum.poc.storage

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private val avatarSelectionMutex = Mutex()

/**
 * One local transaction owns the new asset and its pointer even if the picker Activity is destroyed.
 * The callback only refreshes UI from preferences; it must never persist a captured old filename.
 */
internal suspend fun commitAvatarSelection(
    preferences: ClientPreferences,
    importAvatar: () -> String?,
    deleteAvatar: (String?) -> Unit,
    onCommitted: () -> Unit,
) = withContext(Dispatchers.IO + NonCancellable) {
    avatarSelectionMutex.withLock {
        val previous = preferences.snapshot().avatarFileName
        var created: String? = null
        var committed = false
        try {
            created = importAvatar()
            preferences.saveAvatar(created)
            committed = true
            onCommitted()
            if (previous != created) runCatching { deleteAvatar(previous) }
        } finally {
            if (!committed && created != null) deleteAvatar(created)
        }
    }
}
