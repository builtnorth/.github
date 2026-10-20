<?php
/**
 * Signs a plugin release zip for siratik/license-manager's update check.
 *
 * Usage: RELEASE_SIGNING_KEY=<base64 Ed25519 secret key> \
 *        php sign-release.php <zip> <slug> <version> <key-id>
 *
 * Prints the signature file (JSON) to stdout. Customer sites install an update only
 * when this signature verifies against a public key built into their plugin code, so
 * a compromised store can't push code.
 *
 * The signed bytes must match Siratik\Cryptography\Signature\Verifier::message() for
 * the purpose "siratik-plugin-release": the purpose, the format version, the key id,
 * then the SHA-256 of each field (slug, version, SHA-256 hex of the zip), one per line.
 * This script can't load that package, so the format is repeated here; change both
 * together.
 */

declare(strict_types=1);

const PURPOSE        = 'siratik-plugin-release';
const FORMAT_VERSION = 'v1';

function fail(string $message): never
{
	fwrite(STDERR, "sign-release: {$message}\n");
	exit(1);
}

[, $zip, $slug, $version, $keyId] = array_pad($argv, 5, '');

if (! function_exists('sodium_crypto_sign_detached')) {
	fail('ext-sodium is required.');
}
if (! is_file($zip) || ! is_readable($zip)) {
	fail('zip not found.');
}
// Same shapes the site accepts: a plugin folder name, the version EddProvider allows, a Verifier key id.
if (preg_match('/^[a-z0-9][a-z0-9_-]*$/D', $slug) !== 1) {
	fail('invalid slug.');
}
if (preg_match('/^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?$/D', $version) !== 1) {
	fail('invalid version.');
}
if (preg_match('/^[a-z0-9_-]{1,64}$/D', $keyId) !== 1) {
	fail('invalid key id.');
}

$secret = base64_decode((string) getenv('RELEASE_SIGNING_KEY'), true);
if ($secret === false || strlen($secret) !== SODIUM_CRYPTO_SIGN_SECRETKEYBYTES) {
	fail('RELEASE_SIGNING_KEY is missing or is not a base64 Ed25519 secret key.');
}

$zipHash = (string) hash_file('sha256', $zip);
$message = implode("\n", [
	PURPOSE,
	FORMAT_VERSION,
	$keyId,
	hash('sha256', $slug),
	hash('sha256', $version),
	hash('sha256', $zipHash),
]);

$signature = sodium_crypto_sign_detached($message, $secret);
$publicKey = sodium_crypto_sign_publickey_from_secretkey($secret);
sodium_memzero($secret);

if (! sodium_crypto_sign_verify_detached($signature, $message, $publicKey)) {
	fail('the signature did not verify.');
}

// The public key isn't secret: printing it lets the release log be checked against the
// key built into the plugins.
fwrite(STDERR, 'Signed ' . $slug . ' ' . $version . ' with ' . $keyId . ' (public key ' . base64_encode($publicKey) . ")\n");

echo json_encode([
	'key_id'    => $keyId,
	'signature' => base64_encode($signature),
	'slug'      => $slug,
	'version'   => $version,
	'sha256'    => $zipHash,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
