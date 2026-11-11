package dev.oraculum.poc.gateway

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import android.content.Context
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class CredentialVaultInstrumentedTest {
    @Test fun realKeystoreEncryptsPersistsAndRejectsTampering() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val endpoint = GatewayEndpoint.parse("https://vault-fixture.invalid/${UUID.randomUUID()}/")
        val credential = newCredential(endpoint, UUID.randomUUID().toString())
        val hash = MessageDigest.getInstance("SHA-256").digest(endpoint.url.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        val file = File(context.noBackupFilesDir, "oraculum-v2-identity/$hash.credential")
        try {
            CredentialVault(context).save(credential)
            assertTrue(file.isFile)
            assertTrue(file.canonicalPath.startsWith(context.noBackupFilesDir.canonicalPath + "/"))
            val encrypted = file.readBytes()
            val raw = encrypted.toString(Charsets.ISO_8859_1)
            assertFalse(raw.contains(credential.secret))
            assertFalse(raw.contains(credential.identity.deviceId))
            val reopened = CredentialVault(context).load(endpoint)
            assertNotNull(reopened)
            assertTrue(reopened!!.secret == credential.secret)
            assertEquals(credential.identity, reopened.identity)

            val tampered = encrypted.copyOf()
            tampered[tampered.lastIndex] = (tampered.last().toInt() xor 1).toByte()
            file.writeBytes(tampered)
            val error = assertThrows(GatewayException::class.java) { CredentialVault(context).load(endpoint) }
            assertEquals("CREDENTIAL_STORAGE_UNAVAILABLE", error.code)
            assertTrue(file.readBytes().contentEquals(tampered)) // Failure never silently replaces the identity.
            file.writeBytes(encrypted)
            assertTrue(CredentialVault(context).load(endpoint)!!.secret == credential.secret)
        } finally {
            listOf(file, File(file.path + ".bak"), File(file.path + ".new")).forEach { it.delete() }
        }
    }
}
