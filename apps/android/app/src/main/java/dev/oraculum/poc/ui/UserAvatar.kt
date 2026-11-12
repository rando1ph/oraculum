package dev.oraculum.poc.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.oraculum.poc.storage.AvatarStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Local avatar pixels are never tinted; a missing image falls back without hiding its nickname. */
@Composable
fun UserAvatar(fileName: String?, label: String, modifier: Modifier = Modifier, size: Dp = 32.dp) {
    val context = LocalContext.current.applicationContext
    val bitmap by produceState<Bitmap?>(null, fileName) {
        value = null
        value = withContext(Dispatchers.IO) { AvatarStore(context).load(fileName) }
    }
    Box(modifier.size(size).clip(CircleShape).background(MaterialTheme.colorScheme.secondaryContainer), contentAlignment = Alignment.Center) {
        val pixels = bitmap
        if (pixels == null) OraculumIcon(OraculumSymbol.Person, "$label 的默认头像", tint = MaterialTheme.colorScheme.onSecondaryContainer, size = size * .65f)
        else Image(pixels.asImageBitmap(), "$label 的头像", Modifier.size(size), contentScale = ContentScale.Crop)
    }
    // Do not recycle: a previous render can still reference pixels after the filename changes.
}
