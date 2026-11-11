package dev.oraculum.poc.gateway

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.io.ByteArrayOutputStream
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class DeviceIdentity(val endpoint: String, val installationId: String, val deviceId: String, val paired: Boolean)

/** Deliberately not a data class: neither toString nor copy may accidentally expose the secret. */
internal class DeviceCredential(val identity: DeviceIdentity, val secret: String)

internal interface CredentialStore {
    fun load(endpoint: GatewayEndpoint): DeviceCredential?
    fun save(credential: DeviceCredential)
}

/** A fresh v2 namespace; no old WebView/Cookie/SQLite state is opened or imported. */
internal class CredentialVault(context: Context) : CredentialStore {
    private val directory = File(context.noBackupFilesDir, "oraculum-v2-identity")
    private val alias = "oraculum.v2.device-credential.aes-gcm"

    @Synchronized
    override fun load(endpoint: GatewayEndpoint): DeviceCredential? = guarded {
        val file = encryptedFile(endpoint.url)
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return@guarded null
        val bytes = file.openRead().use { input ->
            val result = ByteArrayOutputStream()
            val chunk = ByteArray(1024)
            while (true) {
                val count = input.read(chunk)
                if (count == -1) break
                require(result.size() + count <= 16_384)
                result.write(chunk, 0, count)
            }
            result.toByteArray()
        }
        try {
            require(bytes.size > 13 && bytes[0] == 1.toByte())
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(create = false), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
            cipher.updateAAD(endpoint.url.toByteArray(Charsets.UTF_8))
            val plaintext = cipher.doFinal(bytes, 13, bytes.size - 13)
            try {
                val value = Json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
                val identity = DeviceIdentity(endpoint.url, value.getValue("installationId").jsonPrimitive.content,
                    value.getValue("deviceId").jsonPrimitive.content, value.getValue("paired").jsonPrimitive.boolean)
                val secret = value.getValue("credential").jsonPrimitive.content
                require(GatewayProtocol.uuid(identity.installationId) && GatewayProtocol.uuid(identity.deviceId) &&
                    Regex("^[A-Za-z0-9_-]{43}$").matches(secret))
                DeviceCredential(identity, secret)
            } finally { plaintext.fill(0) }
        } finally { bytes.fill(0) }
    }

    @Synchronized
    override fun save(credential: DeviceCredential): Unit = guarded {
        check(directory.isDirectory || directory.mkdirs())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(create = true))
        cipher.updateAAD(credential.identity.endpoint.toByteArray(Charsets.UTF_8))
        val value = buildJsonObject {
            put("installationId", credential.identity.installationId)
            put("deviceId", credential.identity.deviceId)
            put("credential", credential.secret)
            put("paired", credential.identity.paired)
        }.toString().toByteArray(Charsets.UTF_8)
        val encrypted = try { byteArrayOf(1) + cipher.iv + cipher.doFinal(value) } finally { value.fill(0) }
        val file = encryptedFile(credential.identity.endpoint)
        val output = file.startWrite()
        try {
            output.write(encrypted)
            file.finishWrite(output)
        } catch (error: Exception) {
            file.failWrite(output)
            throw error
        } finally { encrypted.fill(0) }
    }

    private fun encryptedFile(endpoint: String): AtomicFile {
        val name = MessageDigest.getInstance("SHA-256").digest(endpoint.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return AtomicFile(File(directory, "$name.credential"))
    }

    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (store.containsAlias(alias)) return store.getKey(alias, null) as SecretKey
        check(create) // Missing/invalidated key is not permission to replace unreadable identity.
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build())
        }.generateKey()
    }

    private fun <T> guarded(block: () -> T): T = try { block() } catch (_: Exception) {
        throw GatewayException("CREDENTIAL_STORAGE_UNAVAILABLE", "设备安全存储不可用。已保留现有身份，请检查设备密钥状态；不会自动创建替代身份。")
    }
}

internal fun newCredential(endpoint: GatewayEndpoint, installationId: String): DeviceCredential {
    val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val secret = try { Base64.getUrlEncoder().withoutPadding().encodeToString(bytes) } finally { bytes.fill(0) }
    return DeviceCredential(DeviceIdentity(endpoint.url, installationId, UUID.randomUUID().toString(), false), secret)
}
