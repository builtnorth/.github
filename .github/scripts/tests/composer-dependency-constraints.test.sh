#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$(mktemp -d)"
VERIFY_DIR="$(mktemp -d)"
export COMPOSER_ROOT_VERSION="1.0.0"
export COMPOSER_HOME="${FIXTURE_DIR}/composer-home"
export BUILTNORTH_COMPOSER_INDEX_URL="file://${FIXTURE_DIR}/composer-index"
trap 'rm -rf "$FIXTURE_DIR" "$VERIFY_DIR"' EXIT

mkdir -p "${FIXTURE_DIR}/composer-index"
printf '{"packages":{}}\n' >"${FIXTURE_DIR}/composer-index/packages.json"

cat >"${FIXTURE_DIR}/composer.json" <<'JSON'
{
  "name": "builtnorth/release-constraint-fixture",
  "description": "Release constraint fixture",
  "type": "library",
  "license": "proprietary",
  "require": {
    "php": ">=8.1",
    "builtnorth/job-dispatcher": "^1.1"
  }
}
JSON

before="$(jq -c '.' "${FIXTURE_DIR}/composer.json")"

(
	cd "$FIXTURE_DIR"
	bash "${SCRIPT_DIR}/pin-builtnorth-composer-deps.sh" prepare
	bash "${SCRIPT_DIR}/pin-builtnorth-composer-deps.sh" pin
	bash "${SCRIPT_DIR}/pin-builtnorth-composer-deps.sh" validate
)

after="$(jq -c '.' "${FIXTURE_DIR}/composer.json")"

if [ "$before" != "$after" ]; then
	echo "FAIL: dependency preparation changed committed constraints." >&2
	diff -u <(echo "$before") <(echo "$after") >&2 || true
	exit 1
fi

configured_url="$(jq -r '.repositories.builtnorth.url' "${COMPOSER_HOME}/config.json")"

if [ "$configured_url" != "$BUILTNORTH_COMPOSER_INDEX_URL" ]; then
	echo "FAIL: expected the private Composer index to be configured globally." >&2
	exit 1
fi

mkdir -p "${VERIFY_DIR}/dependency"
cat >"${VERIFY_DIR}/dependency/composer.json" <<'JSON'
{
  "name": "builtnorth/test-dependency",
  "version": "1.2.3",
  "type": "library"
}
JSON

cat >"${VERIFY_DIR}/composer.json" <<'JSON'
{
  "name": "builtnorth/release-lock-fixture",
  "description": "Release lock fixture",
  "type": "library",
  "license": "proprietary",
  "repositories": [
    {
      "type": "path",
      "url": "dependency",
      "options": {
        "symlink": false
      }
    },
    {
      "packagist.org": false
    }
  ],
  "require": {
    "builtnorth/test-dependency": "^1.1"
  }
}
JSON

(
	cd "$VERIFY_DIR"
	composer update --no-dev --no-scripts --no-interaction --quiet
	bash "${SCRIPT_DIR}/pin-builtnorth-composer-deps.sh" verify
)

echo "PASS: Composer dependency constraints remain authoritative."
