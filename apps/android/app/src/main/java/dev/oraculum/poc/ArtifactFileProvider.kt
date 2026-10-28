package dev.oraculum.poc

import androidx.core.content.FileProvider

// Android's FileProvider contract recommends a concrete default-ctor subclass.
class ArtifactFileProvider : FileProvider()
