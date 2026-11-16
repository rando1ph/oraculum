# Desktop window icon

`icon.png` is a 256 × 256 rasterization of the complete approved
`design/brand/oracle-eye-user/oraculum_oracle_eye_outline.svg`, using the Light
accent `#466632`. Only `currentColor` was supplied at rasterization; paths,
geometry, opacity and transparent background are unchanged. It is a source
asset for Electron's native window icon, not a new logo or installer artifact.
The React interface uses an unmodified copy of the original SVG with semantic
theme color.

Source SVG SHA-256:
`e0a6f6929764743544dbde7f39f1086b2fc922c64d482a62f7233ae2c69d7ba6`.

The raster was generated with Ubuntu GdkPixbuf's SVG loader. Ordinary builds
copy this checked-in icon and require no image conversion tools.
