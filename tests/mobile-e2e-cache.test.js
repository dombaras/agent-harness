"use strict";
/* F-331 / F-044 drift guard: the APK cache is a pure accelerator, never a
 * source of a wrong-backend bundle.
 *
 * `EXPO_PUBLIC_API_URL` is not a Gradle task input, so a build for another
 * environment left `createBundleReleaseJsAndAssets` UP-TO-DATE and shipped the
 * stale URL (F-331: the emulator called uat, where the dev-minted actors do not
 * exist, so every login 401'd). LibraryOS carried that fix as a hand-edit of
 * harness-owned files, which is exactly what made `agent-harness update` fail
 * closed there (F-044). The template now ships the fix; these assertions keep
 * the deployed copy from regressing to the hand-edit.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "templates", "scripts", "qa", "mobile-e2e");
const BUILD = fs.readFileSync(path.join(DIR, "build-apk.sh"), "utf8");
const CACHE = fs.readFileSync(path.join(DIR, "apk-cache.js"), "utf8");

test("[drift-guard] build-apk verifies the baked API URL before reusing a cached APK (F-331)", () => {
  assert.match(BUILD, /verify_baked_api_url\(\) \{/, "the verification helper exists");
  assert.match(BUILD, /unzip -p "\$apk" assets\/index\.android\.bundle/, "reads the packaged JS bundle");
  assert.match(BUILD, /grep -a -F -- "\$API_URL"/, "compares the embedded URL exactly");
  const fnStart = BUILD.indexOf("verify_baked_api_url() {");
  const fnBody = BUILD.slice(fnStart, BUILD.indexOf("\n}\n", fnStart)).replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(
    fnBody,
    /grep\s+-q/,
    "no `grep -q`: under pipefail its early exit SIGPIPEs unzip and fails a good APK"
  );
  assert.strictEqual(
    (BUILD.match(/verify_baked_api_url "\$hit"/g) || []).length,
    2,
    "both the exact cache hit and the overlay hit are verified"
  );
  const get = BUILD.indexOf('CACHE_JS}" get');
  const verify = BUILD.indexOf('verify_baked_api_url "$hit"');
  assert.ok(get > 0 && verify > get, "the cache hit is verified before it is reused");
  const finalVerify = BUILD.indexOf('verify_baked_api_url "${APK}" || exit 1');
  const put = BUILD.indexOf("base-put");
  assert.ok(finalVerify > 0 && finalVerify < put, "only a verified APK is written to the cache");
});

test("[drift-guard] build-apk drops the generated bundle tree before Gradle (F-331)", () => {
  const clean = BUILD.indexOf('rm -rf "${ANDROID_DIR}/app/build/generated/assets/react"');
  const gradle = BUILD.indexOf("./gradlew");
  assert.ok(clean > 0, "the stale generated bundle tree is removed");
  assert.ok(gradle > clean, "the removal happens before the Gradle build");
  assert.match(BUILD, /app\/build\/generated\/res\/react/, "the generated resource tree is removed too");
});

test("[drift-guard] the APK cache bundle key was bumped to v2 (F-331)", () => {
  assert.match(CACHE, /function bundleKey\(\)/, "the bundle key is computed");
  assert.match(CACHE, /^\s*v: 2,$/m, "v1 entries (a bundle baked for another backend) are never reused");
});
