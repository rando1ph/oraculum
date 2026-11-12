package dev.oraculum.poc.storage

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.util.AtomicFile
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.util.UUID

/** Device-only images. Call from IO; an imported image never becomes a Gateway attachment. */
class AvatarStore(context: Context) {
    private val resolver = context.contentResolver
    private val directory = File(context.filesDir, "identity-avatars-v2")

    /** Copy during the SAF grant, so reopening never depends on a retained external URI grant. */
    fun importAvatar(uri: Uri): String {
        require(uri.scheme == "content") { "请选择系统文件选择器中的图片。" }
        return resolver.openInputStream(uri)?.use(::importStream) ?: error("无法读取所选图片。")
    }

    internal fun importStream(input: InputStream): String {
        val bytes = boundedBytes(input, MAX_SOURCE_BYTES)
        require(bytes.isNotEmpty()) { "图片不能为空。" }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outMimeType in setOf("image/jpeg", "image/png", "image/webp")) { "请选择 JPG、PNG 或 WebP 图片。" }
        require(validDimensions(bounds.outWidth, bounds.outHeight)) { "图片分辨率过大或内容损坏，请换一张图片。" }
        val decoded = decode(bytes, bounds)
        val cropped = Bitmap.createBitmap(AVATAR_SIZE, AVATAR_SIZE, Bitmap.Config.ARGB_8888)
        try {
            val side = minOf(decoded.width, decoded.height)
            val left = (decoded.width - side) / 2
            val top = (decoded.height - side) / 2
            Canvas(cropped).drawBitmap(decoded, Rect(left, top, left + side, top + side),
                RectF(0f, 0f, AVATAR_SIZE.toFloat(), AVATAR_SIZE.toFloat()), Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
            val encoded = ByteArrayOutputStream().use { output ->
                check(cropped.compress(Bitmap.CompressFormat.PNG, 100, output)) { "头像保存失败。" }
                output.toByteArray()
            }
            check(encoded.size <= MAX_STORED_BYTES) { "头像保存失败，请换一张图片。" }
            check(directory.isDirectory || directory.mkdirs()) { "无法创建本机头像存储。" }
            val name = "avatar-${UUID.randomUUID()}.png"
            val atomic = AtomicFile(checkNotNull(localFile(name)))
            val output = atomic.startWrite()
            try {
                output.write(encoded)
                atomic.finishWrite(output)
            } catch (failure: Exception) {
                atomic.failWrite(output)
                throw failure
            }
            return name
        } finally {
            // These two buffers were never published to Compose; display buffers are owned by GC.
            decoded.recycle()
            cropped.recycle()
        }
    }

    /** Missing, corrupt or unexpected local files fail back to the built-in avatar. */
    fun load(fileName: String?): Bitmap? = try {
        val file = localFile(fileName)
        if (file == null || !file.isFile || file.length() !in 1..MAX_STORED_BYTES.toLong()) null
        else {
            val bytes = file.inputStream().use { boundedBytes(it, MAX_STORED_BYTES) }
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outMimeType != "image/png" || bounds.outWidth != AVATAR_SIZE || bounds.outHeight != AVATAR_SIZE) null
            else BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }
    } catch (_: Exception) { null }

    /** Only an explicitly replaced/removed avatar may be removed by the caller after saving preferences. */
    fun delete(fileName: String?) { localFile(fileName)?.let { AtomicFile(it).delete() } }

    private fun localFile(fileName: String?): File? {
        if (fileName == null || !isAvatarFileName(fileName)) return null
        val file = File(directory, fileName)
        // Android may alias the app's data directory; reject a file symlink without rejecting that directory alias.
        return file.takeIf { it.canonicalFile == File(directory.canonicalFile, fileName) }
    }

    private fun decode(bytes: ByteArray, bounds: BitmapFactory.Options): Bitmap {
        if (Build.VERSION.SDK_INT >= 28) {
            return ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
                require(validDimensions(info.size.width, info.size.height)) { "图片分辨率过大。" }
                val ratio = minOf(1.0, MAX_DECODE_SIDE.toDouble() / maxOf(info.size.width, info.size.height))
                decoder.setTargetSize((info.size.width * ratio).toInt().coerceAtLeast(1), (info.size.height * ratio).toInt().coerceAtLeast(1))
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                // ImageDecoder applies encoded orientation; partial/truncated images remain rejected.
            }
        }
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_DECODE_SIDE) sample *= 2
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: error("图片解码失败，请换一张图片。")
        val orientation = bytes.inputStream().use { stream ->
            runCatching { ExifInterface(stream).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
                .getOrDefault(ExifInterface.ORIENTATION_NORMAL)
        }
        val matrix = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
                ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
            }
        }
        if (matrix.isIdentity) return bitmap
        return try { Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true) }
        finally { bitmap.recycle() }
    }

    companion object {
        const val AVATAR_SIZE = 256
        const val MAX_SOURCE_BYTES = 8 * 1024 * 1024
        private const val MAX_STORED_BYTES = 512 * 1024
        private const val MAX_DECODE_SIDE = 512
        internal fun validDimensions(width: Int, height: Int) = width in 1..8192 && height in 1..8192 && width.toLong() * height <= 32_000_000
        internal fun boundedBytes(input: InputStream, limit: Int): ByteArray {
            val output = ByteArrayOutputStream(minOf(limit, 8192))
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer, 0, minOf(buffer.size, limit - output.size() + 1))
                if (count < 0) break
                if (count == 0) {
                    val single = input.read()
                    if (single < 0) break
                    require(output.size() < limit) { "图片不能超过 8 MB。" }
                    output.write(single)
                } else {
                    require(count <= limit - output.size()) { "图片不能超过 8 MB。" }
                    output.write(buffer, 0, count)
                }
            }
            return output.toByteArray()
        }
    }
}
