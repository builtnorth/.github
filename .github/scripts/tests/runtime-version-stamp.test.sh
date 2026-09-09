#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

mkdir -p "${FIXTURE_DIR}/inc/Core" "${FIXTURE_DIR}/inc/classes/Base"

cat >"${FIXTURE_DIR}/inc/Core/Constants.php" <<'PHP'
<?php
final class Constants {
	public const VERSION = '9.9.9';
}
PHP

cat >"${FIXTURE_DIR}/inc/classes/Base/DefineConstants.php" <<'PHP'
<?php
$constants = [
	'POLARIS_VERSION' => '9.9.9',
];
PHP

(
	cd "$FIXTURE_DIR"
	bash "${SCRIPT_DIR}/stamp-composer-runtime-version.sh" v2.4.0
)

grep -q "public const VERSION = '2.4.0';" "${FIXTURE_DIR}/inc/Core/Constants.php"
grep -q "'POLARIS_VERSION' => '2.4.0'," "${FIXTURE_DIR}/inc/classes/Base/DefineConstants.php"

echo "PASS: runtime version metadata follows the release version."
