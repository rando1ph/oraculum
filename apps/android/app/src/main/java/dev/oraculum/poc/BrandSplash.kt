package dev.oraculum.poc

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.animation.LinearInterpolator
import android.widget.Button
import android.widget.LinearLayout
import kotlin.math.min
import kotlin.math.sin

/** Entirely local branding. Readiness, pairing and errors always preempt the animation. */
class BrandSplash @JvmOverloads constructor(context: Context, animateEntrance: Boolean = false,
    settings: () -> Unit = {}) : LinearLayout(context) {
    private val artwork = OracleArtwork(context, animateEntrance)
    private var dismissed = false

    init {
        orientation = VERTICAL
        setBackgroundColor(Color.BLACK)
        addView(artwork, LayoutParams(-1, 0, 1f))
        addView(Button(context).apply {
            text = context.getString(R.string.server_settings)
            isAllCaps = false
            textSize = 13f
            setTextColor(Color.rgb(164, 194, 216))
            setBackgroundColor(Color.TRANSPARENT)
            minHeight = dp(48)
            setOnClickListener { settings() }
        }, LayoutParams(-2, dp(48)).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            bottomMargin = dp(12)
        })
    }

    fun dismiss(immediate: Boolean = false) {
        if (dismissed) return
        dismissed = true
        artwork.settle()
        // The real interface can receive input throughout this short dissolve.
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        for (index in 0 until childCount) getChildAt(index).isClickable = false
        val remove = { (parent as? ViewGroup)?.removeView(this); Unit }
        if (immediate || !ValueAnimator.areAnimatorsEnabled()) remove()
        else animate().alpha(0f).setDuration(160).withEndAction(remove).start()
    }

    override fun onDetachedFromWindow() {
        animate().cancel()
        artwork.settle()
        super.onDetachedFromWindow()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}

private class OracleArtwork @JvmOverloads constructor(context: Context, private val animateEntrance: Boolean = false) : View(context) {
    private val eye = BitmapFactory.decodeResource(resources, R.drawable.oracle_eye_mark)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val density = resources.displayMetrics.density
    private val fontScale = resources.configuration.fontScale
    private val ice = Color.rgb(180, 222, 255)
    private val white = Color.rgb(237, 246, 255)
    private val serif = Typeface.create("serif", Typeface.NORMAL)
    private val sans = Typeface.create("sans-serif", Typeface.NORMAL)
    private val bitmapBounds = RectF()
    private val name = context.getString(R.string.brand_name)
    private val chineseName = context.getString(R.string.app_name)
    private val declaration = context.getString(R.string.brand_declaration)
    private val englishDeclaration = context.getString(R.string.brand_declaration_english)
    private var coreGlow: Shader? = null
    private var landscape = false
    private var textScale = 1f
    private var size = 0f
    private var cx = 0f
    private var cy = 0f
    private var top = 0f
    private var frame = 1400f
    private var entrance: ValueAnimator? = null
    private var started = false

    init {
        contentDescription = context.getString(R.string.brand_accessibility)
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (started) return
        started = true
        if (!animateEntrance || !ValueAnimator.areAnimatorsEnabled()) return
        frame = 0f
        entrance = ValueAnimator.ofFloat(0f, 1400f).apply {
            duration = 1400
            interpolator = LinearInterpolator()
            addUpdateListener { frame = it.animatedValue as Float; invalidate() }
            start()
        }
    }

    fun settle() {
        entrance?.cancel()
        entrance = null
        frame = 1400f
        invalidate()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        // Returning from the background never restarts the full ceremony.
        if (visibility != VISIBLE && started) settle()
    }

    override fun onDetachedFromWindow() { settle(); super.onDetachedFromWindow() }

    private fun reveal(start: Float, duration: Float): Float {
        val value = ((frame - start) / duration).coerceIn(0f, 1f)
        return value * value * (3f - 2f * value)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        landscape = w > h * 1.2f
        // Fit the complete inscription at large system font sizes and in
        // landscape, while allowing normal accessibility scaling when it fits.
        textScale = min(fontScale, if (landscape) h / (180f * density)
            else h * .54f / (164f * density))
        size = min(w * if (landscape) .32f else .62f, h * if (landscape) .82f else .44f)
        cx = w * if (landscape) .25f else .5f
        val stack = size + 164f * density * textScale
        top = if (landscape) (h - size) / 2f else ((h - stack) / 2f).coerceAtLeast(8f * density)
        cy = top + size / 2f
        coreGlow = if (size > 0f) RadialGradient(cx, cy, size * .23f,
            intArrayOf(white, Color.rgb(82, 174, 255), Color.TRANSPARENT),
            floatArrayOf(0f, .22f, 1f), Shader.TileMode.CLAMP) else null
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (size <= 0f) return
        val outline = reveal(0f, 440f)
        val scale = .92f + .08f * outline

        paint.style = Paint.Style.STROKE
        paint.strokeWidth = density * .55f
        paint.color = ice
        paint.alpha = ((1f - reveal(620f, 420f)) * 65).toInt()
        val axis = size * (.65f - .15f * outline)
        canvas.drawLine(cx - axis, cy, cx - size * .38f, cy, paint)
        canvas.drawLine(cx + size * .38f, cy, cx + axis, cy, paint)
        canvas.drawLine(cx, cy - axis, cx, cy - size * .38f, paint)
        canvas.drawLine(cx, cy + size * .38f, cx, cy + axis, paint)
        paint.style = Paint.Style.FILL
        paint.alpha = (30 + 225 * outline).toInt()
        val half = size * scale / 2f
        bitmapBounds.set(cx - half, cy - half, cx + half, cy + half)
        canvas.drawBitmap(eye, null, bitmapBounds, paint)

        // One restrained core pulse and ring; the approved bitmap is never redrawn.
        val pulse = sin(((frame - 330f) / 520f).coerceIn(0f, 1f) * Math.PI).toFloat()
        if (pulse > .001f) {
            paint.alpha = (pulse * 110).toInt()
            paint.shader = coreGlow
            canvas.drawCircle(cx, cy, size * .23f, paint)
            paint.shader = null
            paint.style = Paint.Style.STROKE
            paint.color = ice
            paint.alpha = (pulse * 65).toInt()
            canvas.drawCircle(cx, cy, size * (.23f + .12f * reveal(330f, 520f)), paint)
            paint.style = Paint.Style.FILL
        }

        val tx = width * if (landscape) .70f else .5f
        val available = width * if (landscape) .51f else .86f
        val spacing = density * textScale
        val base = if (landscape) height / 2f - 48f * spacing else top + size + 26f * spacing
        lettering(canvas, name, tx, base, 24f, 4.8f,
            available, white, reveal(420f, 340f), true, textScale)
        lettering(canvas, chineseName, tx, base + 35f * spacing, 21f, 9f,
            available, ice, reveal(570f, 320f), true, textScale)
        lettering(canvas, declaration, tx, base + 82f * spacing, 16f, 1.2f,
            available, white, reveal(760f, 320f), true, textScale)
        lettering(canvas, englishDeclaration, tx, base + 108f * spacing, 9f, 1.8f,
            available, Color.rgb(139, 171, 195), reveal(940f, 320f), false, textScale)
    }

    private fun lettering(canvas: Canvas, text: String, x: Float, y: Float, size: Float, tracking: Float,
        available: Float, color: Int, opacity: Float, useSerif: Boolean, textScale: Float) {
        paint.typeface = if (useSerif) serif else sans
        paint.textSize = size * density * textScale
        var gap = tracking * density
        var length = paint.measureText(text) + gap * (text.length - 1)
        if (length > available) {
            val fit = available / length
            paint.textSize *= fit
            gap *= fit
            length = available
        }
        paint.color = color
        paint.alpha = (255f * opacity).toInt()
        var left = x - length / 2f
        for (character in text) {
            val letter = character.toString()
            canvas.drawText(letter, left, y + (1f - opacity) * 5f * density, paint)
            left += paint.measureText(letter) + gap
        }
    }
}
