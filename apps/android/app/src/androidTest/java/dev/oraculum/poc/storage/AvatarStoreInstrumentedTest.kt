package dev.oraculum.poc.storage

import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.ExifInterface
import android.system.Os
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test

class AvatarStoreInstrumentedTest {
    @Test fun importedPixelsSurviveReopenWithoutSourcePermissionOrMetadata() = isolated { context ->
        val source = File(context.filesDir, "source.jpg")
        writeTwoColorJpeg(source)
        ExifInterface(source.path).apply {
            setAttribute(ExifInterface.TAG_MAKE, "private-camera-marker")
            setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
            saveAttributes()
        }
        val name = source.inputStream().use { AvatarStore(context).importStream(it) }
        assertTrue(isAvatarFileName(name))
        assertTrue(source.delete())
        val restored = checkNotNull(AvatarStore(context).load(name))
        try {
            assertEquals(256, restored.width)
            assertEquals(256, restored.height)
            val top = restored.getPixel(128, 32)
            val bottom = restored.getPixel(128, 224)
            assertTrue("EXIF orientation must rotate left red half to top", Color.red(top) > 220 && Color.blue(top) < 30)
            assertTrue("EXIF orientation must rotate right blue half to bottom", Color.blue(bottom) > 220 && Color.red(bottom) < 30)
            val bytes = avatarFile(context, name).readBytes()
            assertFalse(bytes.toString(Charsets.ISO_8859_1).contains("private-camera-marker"))
            assertTrue(bytes.size < 512 * 1024)
        } finally { restored.recycle() }
    }

    @Test fun failedImportLeavesPreviousAvatarAndOtherPrivateFilesUntouched() = isolated { context ->
        val store = AvatarStore(context)
        val name = store.importStream(png().inputStream())
        val original = avatarFile(context, name).readBytes()
        val private = File(context.filesDir, "drafts.db").apply { writeText("protected") }
        assertThrows(IllegalArgumentException::class.java) { store.importStream("not a bitmap".byteInputStream()) }
        assertThrows(IllegalArgumentException::class.java) { store.importStream(ByteArray(AvatarStore.MAX_SOURCE_BYTES + 1).inputStream()) }
        store.delete("../drafts.db")
        store.delete(private.absolutePath)
        assertEquals("protected", private.readText())
        assertArrayEquals(original, avatarFile(context, name).readBytes())
        assertEquals(listOf(name), File(context.filesDir, "identity-avatars-v2").list()!!.toList())
        val linkName = "avatar-${UUID.randomUUID()}.png"
        val link = avatarFile(context, linkName)
        Os.symlink(private.path, link.path)
        assertNull(store.load(linkName))
        store.delete(linkName)
        assertEquals("protected", private.readText())
    }

    @Test fun missingCorruptAndOversizedStoredImagesFallBackWithoutEscapingStorage() = isolated { context ->
        val store = AvatarStore(context)
        val name = "avatar-${UUID.randomUUID()}.png"
        assertNull(store.load(name))
        assertNull(store.load("../drafts.db"))
        val file = avatarFile(context, name).apply { parentFile!!.mkdirs(); writeText("bad-png") }
        assertNull(store.load(name))
        file.writeBytes(png(512))
        assertNull(store.load(name))
        file.writeBytes(png())
        val valid = checkNotNull(store.load(name))
        valid.recycle()
        store.delete(name)
        assertFalse(file.exists())
    }

    @Test fun pngTransparencyIsPreservedByPrivateReencoding() = isolated { context ->
        val store = AvatarStore(context)
        val name = store.importStream(png().inputStream())
        val result = checkNotNull(store.load(name))
        try { assertEquals(0, Color.alpha(result.getPixel(0, 0))) }
        finally { result.recycle() }
    }

    private fun avatarFile(context: Context, name: String) = File(File(context.filesDir, "identity-avatars-v2"), name)
    private fun png(size: Int = 256): ByteArray {
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        return try { ByteArrayOutputStream().use { output -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, output); output.toByteArray() } }
        finally { bitmap.recycle() }
    }
    private fun writeTwoColorJpeg(file: File) {
        val bitmap = Bitmap.createBitmap(200, 100, Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(bitmap)
            canvas.drawRect(0f, 0f, 100f, 100f, Paint().apply { color = Color.RED })
            canvas.drawRect(100f, 0f, 200f, 100f, Paint().apply { color = Color.BLUE })
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 100, it) }
        } finally { bitmap.recycle() }
    }
    private fun isolated(test: (Context) -> Unit) {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(base.cacheDir, "avatar-test-${UUID.randomUUID()}").apply { mkdirs() }
        val context = object : ContextWrapper(base) {
            override fun getApplicationContext(): Context = this
            override fun getFilesDir() = root
        }
        try { test(context) } finally { root.deleteRecursively() }
    }
}
