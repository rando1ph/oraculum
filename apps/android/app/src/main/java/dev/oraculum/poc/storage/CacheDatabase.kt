package dev.oraculum.poc.storage

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
abstract class CacheDao {
    @Query("SELECT * FROM projections WHERE scopeKey = :scopeKey AND projectId = :projectId AND kind = :kind AND resourceId = :resourceId AND pageKey = :pageKey")
    abstract suspend fun get(scopeKey: String, kind: String, resourceId: String = "", pageKey: String = "", projectId: String = ""): CachedProjection?

    @Query("SELECT * FROM projections WHERE scopeKey = :scopeKey AND kind = :kind AND (:projectId IS NULL OR projectId = :projectId) ORDER BY loadedAt, resourceId, pageKey")
    abstract suspend fun listByKind(scopeKey: String, kind: String, projectId: String? = null): List<CachedProjection>

    @Query("SELECT * FROM projections WHERE scopeKey = :scopeKey AND kind = :kind AND (:projectId IS NULL OR projectId = :projectId) ORDER BY loadedAt, resourceId, pageKey")
    abstract fun observeByKind(scopeKey: String, kind: String, projectId: String? = null): Flow<List<CachedProjection>>

    /** Caller accepts only the active epoch/revision; revisions are opaque, not sortable numbers. */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun put(projection: CachedProjection)

    @Query("DELETE FROM projections WHERE scopeKey = :scopeKey AND projectId = :projectId AND threadId = :threadId")
    abstract suspend fun deleteThread(scopeKey: String, projectId: String, threadId: String)

    @Query("DELETE FROM projections WHERE scopeKey = :scopeKey")
    protected abstract suspend fun deleteProjections(scopeKey: String)

    @Query("DELETE FROM event_cursors WHERE scopeKey = :scopeKey")
    protected abstract suspend fun deleteCursor(scopeKey: String)

    @Query("DELETE FROM projections")
    protected abstract suspend fun deleteAllProjections()

    @Query("DELETE FROM event_cursors")
    protected abstract suspend fun deleteAllCursors()

    @Query("SELECT * FROM event_cursors WHERE scopeKey = :scopeKey")
    abstract suspend fun cursor(scopeKey: String): StoredEventCursor?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    protected abstract suspend fun putCursor(cursor: StoredEventCursor)

    /** Cursor advances only in the same transaction as the projection which reflects that event. */
    @Transaction
    open suspend fun putWithCursor(projection: CachedProjection, cursor: StoredEventCursor) {
        require(projection.scopeKey == cursor.scopeKey && projection.epoch == cursor.epoch)
        put(projection)
        putCursor(cursor)
    }

    @Transaction
    open suspend fun clearScope(scopeKey: String) {
        deleteProjections(scopeKey)
        deleteCursor(scopeKey)
    }

    @Transaction
    open suspend fun clearAll() {
        deleteAllProjections()
        deleteAllCursors()
    }
}

@Database(entities = [CachedProjection::class, StoredEventCursor::class], version = 1, exportSchema = false)
abstract class CacheDatabase : RoomDatabase() {
    abstract fun cache(): CacheDao

    companion object {
        const val FILE_NAME = "oraculum-v2-cache.db"

        fun open(context: Context, name: String = FILE_NAME): CacheDatabase =
            Room.databaseBuilder(context.applicationContext, CacheDatabase::class.java, name).build()
    }
}
