/** Phase 3 profile of the real Codex-backed, disposable loopback fixture. */
import { runAndroidFixture } from './android-v2-fixture';

runAndroidFixture('phase3').catch(() => {
  process.stderr.write('Phase 3 Android fixture could not initialize safely.\n');
  process.exitCode = 1;
});
