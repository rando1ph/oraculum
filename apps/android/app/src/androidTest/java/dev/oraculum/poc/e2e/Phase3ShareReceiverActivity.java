package dev.oraculum.poc.e2e;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

/** Test APK only; no Kotlin/application runtime, network, persisted URI grant or writable open. */
public final class Phase3ShareReceiverActivity extends Activity {
    private static final String EXPECTED_TEXT = "# Phase 3 文件预览\n\n仅用于隔离 Android 验收。\n\n"
        + "- [x] UTF-8\n- [ ] 未发送的草稿\n\n```kotlin\nval verified = true\n```\n";
    private static final String EXPECTED_SHA256 = "92ba25eb3cd32527ef0ef220d24ce6f29978ad295459891e1ffd5c0236c6c8b1";
    private static final String AUTHORITY = "dev.oraculum.poc.debug.artifacts";
    private static final String RECEIPT = "phase3-share-receipt.json";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        JSONObject receipt = new JSONObject();
        boolean verified = false;
        String check = "initialization";
        try {
            receipt.put("createdAt", System.currentTimeMillis());
            receipt.put("receiverUid", Process.myUid());
            receipt.put("receiverPackage", getPackageName());
            Intent incoming = getIntent();
            check = "action-and-mime";
            require(Intent.ACTION_SEND.equals(incoming.getAction()) && "text/markdown".equals(incoming.getType()));
            Object stream = incoming.getParcelableExtra(Intent.EXTRA_STREAM);
            check = "content-uri";
            require(stream instanceof Uri);
            Uri uri = (Uri) stream;
            require("content".equals(uri.getScheme()) && AUTHORITY.equals(uri.getAuthority()));
            boolean readFlag = (incoming.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0;
            boolean writeFlag = (incoming.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0;
            boolean readGranted = checkUriPermission(uri, Process.myPid(), Process.myUid(),
                Intent.FLAG_GRANT_READ_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED;
            boolean writeGranted = checkUriPermission(uri, Process.myPid(), Process.myUid(),
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED;
            receipt.put("readFlag", readFlag).put("writeFlag", writeFlag)
                .put("readGranted", readGranted).put("writeGranted", writeGranted);
            check = "read-only-grant";
            require(readFlag && readGranted && !writeFlag && !writeGranted);
            check = "bounded-content-read";
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream input = getContentResolver().openInputStream(uri)) {
                require(input != null);
                byte[] buffer = new byte[256];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    require(bytes.size() + count <= 1024);
                    bytes.write(buffer, 0, count);
                }
            }
            byte[] actual = bytes.toByteArray();
            String digest = hex(MessageDigest.getInstance("SHA-256").digest(actual));
            receipt.put("bytes", actual.length).put("sha256", digest);
            check = "exact-test-content";
            require(actual.length == 131 && Arrays.equals(actual, EXPECTED_TEXT.getBytes(StandardCharsets.UTF_8))
                && EXPECTED_SHA256.equals(digest));
            receipt.put("contentMatches", true);
            verified = true;
        } catch (Exception error) {
            // Keep the receipt non-sensitive: never log the URI, file content or exception message.
            try { receipt.put("failedCheck", check); } catch (Exception ignored) { }
        }
        try {
            receipt.put("verified", verified);
            try (OutputStream output = openFileOutput(RECEIPT, MODE_PRIVATE)) {
                output.write(receipt.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception error) { verified = false; }

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(32, 48, 32, 32);
        layout.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(32, 32 + insets.getSystemWindowInsetTop(), 32,
                32 + insets.getSystemWindowInsetBottom());
            return insets;
        });
        TextView title = new TextView(this);
        title.setText("Phase 3 share receiver");
        title.setTextSize(24);
        layout.addView(title);
        TextView result = new TextView(this);
        result.setText(verified ? "Verified 131 bytes, SHA-256, exact content and read-only URI grant."
            : "Share verification failed; inspect the private test receipt.");
        layout.addView(result);
        Button close = new Button(this);
        close.setText("Return to Oraculum");
        close.setAllCaps(false);
        close.setOnClickListener(view -> finish());
        layout.addView(close);
        setContentView(layout);
        layout.requestApplyInsets();
    }

    private static void require(boolean condition) {
        if (!condition) throw new IllegalStateException("Test share did not satisfy its contract");
    }

    private static String hex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray();
        char[] output = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            output[i * 2] = digits[(bytes[i] >>> 4) & 15];
            output[i * 2 + 1] = digits[bytes[i] & 15];
        }
        return new String(output);
    }
}
