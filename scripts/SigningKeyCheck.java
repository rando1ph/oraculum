import java.io.Console;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.util.Arrays;
import java.util.HexFormat;

// Run only in the user's local terminal. Passwords never enter argv or a file.
class SigningKeyCheck {
    public static void main(String[] args) throws Exception {
        Console console = System.console();
        if (console == null || args.length != 4) throw new IllegalStateException("A local terminal and primary/backup/alias/public-result path are required");
        char[] storePassword = null;
        char[] keyPassword = null;
        try {
            storePassword = console.readPassword("JKS password (verify primary and backup): ");
            keyPassword = console.readPassword("Key password (Enter = same as JKS): ");
            if (storePassword == null || keyPassword == null) throw new IllegalStateException("Input cancelled");
            if (keyPassword.length == 0) keyPassword = storePassword.clone();
            byte[] certificate = null;
            for (int i = 0; i < 2; i++) {
                KeyStore store = KeyStore.getInstance("JKS");
                try (var input = Files.newInputStream(Path.of(args[i]))) { store.load(input, storePassword); }
                if (store.size() != 1 || !store.isKeyEntry(args[2])) throw new IllegalStateException("Expected one dedicated release key");
                var key = store.getKey(args[2], keyPassword);
                if (!(key instanceof PrivateKey)) throw new IllegalStateException("Private key cannot be unlocked");
                var cert = store.getCertificate(args[2]);
                if (!(cert instanceof java.security.cert.X509Certificate x509)) throw new IllegalStateException("Expected an X.509 release certificate");
                x509.checkValidity();
                if (!(cert.getPublicKey() instanceof java.security.interfaces.RSAPublicKey rsa) || rsa.getModulus().bitLength() < 3072)
                    throw new IllegalStateException("Expected a dedicated RSA key of at least 3072 bits");
                if (x509.getSubjectX500Principal().getName().contains("Android Debug")) throw new IllegalStateException("Debug certificate is not a release key");
                byte[] encoded = cert.getEncoded();
                if (certificate != null && !Arrays.equals(certificate, encoded)) throw new IllegalStateException("Backup certificate mismatch");
                certificate = encoded;
                Signature proof = Signature.getInstance("SHA256withRSA");
                byte[] challenge = "Oraculum local release backup verification".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                proof.initSign((PrivateKey) key); proof.update(challenge); byte[] signature = proof.sign();
                proof.initVerify(cert); proof.update(challenge);
                if (!proof.verify(signature)) throw new IllegalStateException("Private-key proof failed");
            }
            String fingerprint = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(certificate));
            Files.writeString(Path.of(args[3]), fingerprint + "\n", java.nio.file.StandardOpenOption.CREATE_NEW);
            System.out.println("CERT_SHA256=" + fingerprint);
            System.out.println("PASS: primary and backup private keys unlock and match");
        } finally {
            if (storePassword != null) Arrays.fill(storePassword, '\0');
            if (keyPassword != null) Arrays.fill(keyPassword, '\0');
        }
    }
}
