#!/usr/bin/env bash
# sign-release.php: a signature over the documented message verifies with the matching
# public key, and bad input or a missing key fails without printing a signature.
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/sign-release.php"
FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

ZIP="${FIXTURE_DIR}/kitaris-thing.zip"
printf 'PK release bytes' >"$ZIP"

PAIR="$(php -r '$p = sodium_crypto_sign_keypair(); echo base64_encode(sodium_crypto_sign_secretkey($p)), " ", base64_encode(sodium_crypto_sign_publickey($p));')"
SECRET="${PAIR% *}"
PUBLIC="${PAIR#* }"

fail() {
	echo "FAIL: $1" >&2
	exit 1
}

# Valid signature, checked with an independent rebuild of the message.
RELEASE_SIGNING_KEY="$SECRET" php "$SCRIPT" "$ZIP" kitaris-thing 2.0.0 releases-v1 >"${FIXTURE_DIR}/sig.json" 2>/dev/null \
	|| fail "signing a valid release failed"

php -r '
	[, $sigFile, $zip, $public] = $argv;
	$sig = json_decode(file_get_contents($sigFile), true);
	$message = implode("\n", ["siratik-plugin-release", "v1", "releases-v1", hash("sha256", "kitaris-thing"), hash("sha256", "2.0.0"), hash("sha256", hash_file("sha256", $zip))]);
	$ok = $sig["key_id"] === "releases-v1"
		&& $sig["sha256"] === hash_file("sha256", $zip)
		&& sodium_crypto_sign_verify_detached(base64_decode($sig["signature"], true), $message, base64_decode($public, true));
	exit($ok ? 0 : 1);
' "${FIXTURE_DIR}/sig.json" "$ZIP" "$PUBLIC" || fail "signature does not verify against the documented message"

# Each of these must fail and print nothing on stdout.
expect_failure() {
	local label="$1"
	shift
	local out
	if out="$("$@" 2>/dev/null)"; then
		fail "$label: expected failure"
	fi
	[ -z "$out" ] || fail "$label: printed output on failure"
}

expect_failure "missing key" env -u RELEASE_SIGNING_KEY php "$SCRIPT" "$ZIP" kitaris-thing 2.0.0 releases-v1
expect_failure "malformed key" env RELEASE_SIGNING_KEY=not-a-key php "$SCRIPT" "$ZIP" kitaris-thing 2.0.0 releases-v1
expect_failure "missing zip" env RELEASE_SIGNING_KEY="$SECRET" php "$SCRIPT" "${FIXTURE_DIR}/none.zip" kitaris-thing 2.0.0 releases-v1
expect_failure "bad slug" env RELEASE_SIGNING_KEY="$SECRET" php "$SCRIPT" "$ZIP" "../evil" 2.0.0 releases-v1
expect_failure "bad version" env RELEASE_SIGNING_KEY="$SECRET" php "$SCRIPT" "$ZIP" kitaris-thing "2.0<b>" releases-v1
expect_failure "bad key id" env RELEASE_SIGNING_KEY="$SECRET" php "$SCRIPT" "$ZIP" kitaris-thing 2.0.0 "Bad Key"

echo "sign-release.test.sh: ok"
