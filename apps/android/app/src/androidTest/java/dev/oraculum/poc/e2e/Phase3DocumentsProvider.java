package dev.oraculum.poc.e2e;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Test APK only. DocumentsUI can launch this provider without the target APK's class loader.
 * Keep it independent of Kotlin, AndroidX and application code; only Android/Java APIs are used.
 */
public final class Phase3DocumentsProvider extends DocumentsProvider {
    private static final String[] ROOT_COLUMNS = {
        Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE,
        Root.COLUMN_FLAGS, Root.COLUMN_MIME_TYPES, Root.COLUMN_AVAILABLE_BYTES
    };
    private static final String[] DOCUMENT_COLUMNS = {
        Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
        Document.COLUMN_FLAGS, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED
    };
    private static final String[] IDS = {"note", "image", "large", "unavailable"};

    private File directory() {
        if (getContext() == null) throw new IllegalStateException("Provider context is unavailable");
        File directory = new File(getContext().getCacheDir(), "phase3-documents");
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IllegalStateException("Test document directory is unavailable");
        }
        return directory;
    }

    @Override
    public boolean onCreate() {
        File directory = directory();
        try {
            try (FileOutputStream output = new FileOutputStream(new File(directory, "note"))) {
                output.write(("PHASE3_ATTACHMENT_VERIFIED\n"
                    + "Generated solely for native Android acceptance.\n").getBytes(StandardCharsets.UTF_8));
            }
            Bitmap bitmap = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888);
            try {
                bitmap.eraseColor(Color.rgb(93, 125, 238));
                try (FileOutputStream output = new FileOutputStream(new File(directory, "image"))) {
                    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) {
                        throw new IOException("Test image could not be encoded");
                    }
                }
            } finally {
                bitmap.recycle();
            }
            try (RandomAccessFile file = new RandomAccessFile(new File(directory, "large"), "rw")) {
                file.setLength(30L * 1024 * 1024);
            }
            return true;
        } catch (IOException error) {
            throw new IllegalStateException("Generated test documents could not be initialized", error);
        }
    }

    @Override
    public Cursor queryRoots(String[] projection) {
        MatrixCursor cursor = new MatrixCursor(projection == null ? ROOT_COLUMNS : projection);
        Map<String, Object> values = new LinkedHashMap<>();
        values.put(Root.COLUMN_ROOT_ID, "phase3");
        values.put(Root.COLUMN_DOCUMENT_ID, "root");
        values.put(Root.COLUMN_TITLE, "Phase 3 test files");
        values.put(Root.COLUMN_FLAGS, Root.FLAG_LOCAL_ONLY | Root.FLAG_SUPPORTS_IS_CHILD);
        values.put(Root.COLUMN_MIME_TYPES, "*/*");
        values.put(Root.COLUMN_AVAILABLE_BYTES, 0L);
        projectedRow(cursor, values);
        return cursor;
    }

    @Override
    public Cursor queryDocument(String documentId, String[] projection) throws FileNotFoundException {
        MatrixCursor cursor = new MatrixCursor(projection == null ? DOCUMENT_COLUMNS : projection);
        addDocument(cursor, documentId);
        return cursor;
    }

    @Override
    public Cursor queryChildDocuments(String parentDocumentId, String[] projection, String sortOrder)
            throws FileNotFoundException {
        if (!"root".equals(parentDocumentId)) throw new FileNotFoundException("Unknown test directory");
        MatrixCursor cursor = new MatrixCursor(projection == null ? DOCUMENT_COLUMNS : projection);
        for (String id : IDS) addDocument(cursor, id);
        return cursor;
    }

    @Override
    public boolean isChildDocument(String parentDocumentId, String documentId) {
        return "root".equals(parentDocumentId) && knownDocument(documentId);
    }

    @Override
    public ParcelFileDescriptor openDocument(String documentId, String mode, CancellationSignal signal)
            throws FileNotFoundException {
        if (signal != null) signal.throwIfCanceled();
        if (!"r".equals(mode) || !knownDocument(documentId) || "unavailable".equals(documentId)) {
            throw new FileNotFoundException("Test document is unavailable");
        }
        return ParcelFileDescriptor.open(new File(directory(), documentId), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    private void addDocument(MatrixCursor cursor, String id) throws FileNotFoundException {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put(Document.COLUMN_DOCUMENT_ID, id);
        values.put(Document.COLUMN_FLAGS, 0);
        if ("root".equals(id)) {
            values.put(Document.COLUMN_DISPLAY_NAME, "Phase 3 test files");
            values.put(Document.COLUMN_MIME_TYPE, Document.MIME_TYPE_DIR);
        } else {
            if (!knownDocument(id)) throw new FileNotFoundException("Unknown test document");
            values.put(Document.COLUMN_DISPLAY_NAME, "phase3-" + id + ("image".equals(id) ? ".png" : ".txt"));
            values.put(Document.COLUMN_MIME_TYPE, "image".equals(id) ? "image/png" : "text/plain");
            values.put(Document.COLUMN_SIZE, "unavailable".equals(id) ? 16L : new File(directory(), id).length());
            values.put(Document.COLUMN_LAST_MODIFIED, 1_700_000_000_000L);
        }
        projectedRow(cursor, values);
    }

    private static boolean knownDocument(String documentId) {
        for (String id : IDS) if (id.equals(documentId)) return true;
        return false;
    }

    private static void projectedRow(MatrixCursor cursor, Map<String, Object> values) {
        MatrixCursor.RowBuilder row = cursor.newRow();
        for (String column : cursor.getColumnNames()) row.add(values.get(column));
    }
}
