package dev.oraculum.poc.storage

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

@Dao
abstract class StateDao {
    @Query("SELECT * FROM drafts WHERE scopeKey = :scopeKey AND projectId = :projectId AND threadId = :threadId")
    abstract suspend fun draft(scopeKey: String, projectId: String, threadId: String): DraftRecord?

    @Query("SELECT * FROM drafts WHERE scopeKey = :scopeKey AND projectId = :projectId AND threadId = :threadId")
    abstract fun observeDraft(scopeKey: String, projectId: String, threadId: String): Flow<DraftRecord?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun putDraft(draft: DraftRecord)

    @Query("SELECT * FROM read_anchors WHERE scopeKey = :scopeKey AND projectId = :projectId AND threadId = :threadId")
    abstract suspend fun readAnchor(scopeKey: String, projectId: String, threadId: String): ReadAnchorRecord?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun putReadAnchor(anchor: ReadAnchorRecord)

    /** ABORT on duplicate ID prevents a second dispatch of an already recorded user intent. */
    @Insert(onConflict = OnConflictStrategy.ABORT)
    protected abstract suspend fun insertOperationRow(operation: OperationRecord)

    open suspend fun insertOperation(operation: OperationRecord) {
        require(operation.status == "unknown" && operation.delivery == "unknown")
        require(operation.operationId.matches(UUID_V4))
        insertOperationRow(operation)
    }

    @Query("SELECT * FROM operations WHERE scopeKey = :scopeKey AND operationId = :operationId")
    abstract suspend fun operation(scopeKey: String, operationId: String): OperationRecord?

    @Query("SELECT * FROM operations WHERE scopeKey = :scopeKey AND status = 'unknown' ORDER BY createdAt, operationId")
    abstract suspend fun unresolved(scopeKey: String): List<OperationRecord>

    @Query("SELECT * FROM operations WHERE scopeKey = :scopeKey AND status = 'unknown' ORDER BY createdAt, operationId")
    abstract fun observeUnresolved(scopeKey: String): Flow<List<OperationRecord>>

    @Query("UPDATE operations SET status = :status, delivery = :delivery, nativeThreadId = COALESCE(:nativeThreadId, nativeThreadId), nativeTurnId = COALESCE(:nativeTurnId, nativeTurnId), receiptJson = :receiptJson, updatedAt = :updatedAt WHERE scopeKey = :scopeKey AND operationId = :operationId AND (status = 'unknown' OR status = :status)")
    protected abstract suspend fun updateReceiptRow(
        scopeKey: String,
        operationId: String,
        status: String,
        delivery: String,
        nativeThreadId: String?,
        nativeTurnId: String?,
        receiptJson: String?,
        updatedAt: Long,
    ): Int

    /** A delayed unknown/rejected response cannot downgrade a terminal accepted receipt. */
    open suspend fun updateOperationReceipt(
        scopeKey: String,
        operationId: String,
        status: String,
        delivery: String,
        nativeThreadId: String? = null,
        nativeTurnId: String? = null,
        receiptJson: String? = null,
        updatedAt: Long = System.currentTimeMillis(),
    ): Int {
        require(status in setOf("unknown", "accepted", "rejected"))
        require(delivery in setOf("unknown", "sent", "notSent"))
        return updateReceiptRow(scopeKey, operationId, status, delivery, nativeThreadId, nativeTurnId, receiptJson, updatedAt)
    }

    private companion object {
        val UUID_V4 = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    }
}

/** Durable client state intentionally has no destructive migration or cache-clear API. */
@Database(entities = [DraftRecord::class, ReadAnchorRecord::class, OperationRecord::class], version = 1, exportSchema = false)
abstract class StateDatabase : RoomDatabase() {
    abstract fun state(): StateDao

    companion object {
        const val FILE_NAME = "oraculum-v2-state.db"

        fun open(context: Context, name: String = FILE_NAME): StateDatabase =
            Room.databaseBuilder(context.applicationContext, StateDatabase::class.java, name)
                .openHelperFactory(PreservingOpenHelperFactory())
                .build()
    }
}
