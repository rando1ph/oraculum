package dev.oraculum.poc.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.oraculum.poc.R

/** A small, bundled set of Google's Material Symbols Outlined (24px / weight 400). */
enum class OraculumSymbol(@DrawableRes internal val drawable: Int) {
    Add(R.drawable.ms_add),
    Search(R.drawable.ms_search),
    Folder(R.drawable.ms_folder),
    Chat(R.drawable.ms_chat_bubble),
    Settings(R.drawable.ms_settings),
    Close(R.drawable.ms_close),
    ChevronRight(R.drawable.ms_chevron_right),
    ExpandMore(R.drawable.ms_expand_more),
    ExpandLess(R.drawable.ms_expand_less),
    ArrowBack(R.drawable.ms_arrow_back),
    Send(R.drawable.ms_arrow_upward),
    Stop(R.drawable.ms_stop_circle),
    AttachFile(R.drawable.ms_attach_file),
    Shield(R.drawable.ms_shield),
    Model(R.drawable.ms_smart_toy),
    Tune(R.drawable.ms_tune),
    Code(R.drawable.ms_code),
    Terminal(R.drawable.ms_terminal),
    Difference(R.drawable.ms_difference),
    DataUsage(R.drawable.ms_data_usage),
    Extension(R.drawable.ms_extension),
    Copy(R.drawable.ms_content_copy),
    Share(R.drawable.ms_share),
    Download(R.drawable.ms_download),
    OpenInNew(R.drawable.ms_open_in_new),
    Refresh(R.drawable.ms_refresh),
    Check(R.drawable.ms_check_circle),
    Warning(R.drawable.ms_warning),
    Error(R.drawable.ms_error),
    Info(R.drawable.ms_info),
    Notifications(R.drawable.ms_notifications),
    Palette(R.drawable.ms_palette),
    TextSize(R.drawable.ms_format_size),
    Person(R.drawable.ms_person),
    History(R.drawable.ms_history),
    Description(R.drawable.ms_description),
    Wifi(R.drawable.ms_wifi),
    WifiOff(R.drawable.ms_wifi_off),
    ViewSidebar(R.drawable.ms_view_sidebar),
    Delete(R.drawable.ms_delete),
}

/**
 * Pass null beside a visible label to avoid duplicate accessibility announcements.
 * Icon-only actions must supply their action label here or on the parent control.
 * The caller owns the 48dp minimum touch target; this controls only the drawing size.
 */
@Composable
fun OraculumIcon(
    symbol: OraculumSymbol,
    contentDescription: String? = null,
    modifier: Modifier = Modifier,
    tint: Color = LocalContentColor.current,
    size: Dp = 20.dp,
) {
    Icon(painterResource(symbol.drawable), contentDescription, modifier.size(size), tint)
}

/** The user's full and compact Oracle Eye artwork, faithfully converted from the supplied SVGs. */
enum class OracleEyeVariant(@DrawableRes internal val drawable: Int) {
    Compact(R.drawable.oracle_eye_compact),
    Full(R.drawable.oracle_eye_full),
}

/** In-app branding only. Full is for large brand areas; Compact is for toolbar/avatar sizes. */
@Composable
fun OracleEyeMark(
    contentDescription: String? = null,
    modifier: Modifier = Modifier,
    tint: Color = MaterialTheme.colorScheme.primary,
    size: Dp = 24.dp,
    variant: OracleEyeVariant = OracleEyeVariant.Compact,
) {
    Icon(painterResource(variant.drawable), contentDescription, modifier.size(size), tint)
}
