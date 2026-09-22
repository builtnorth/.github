#!/usr/bin/env bash
# Verify a package's runtime version metadata matches the release version.
#
# The stamping step is skipped on tag pushes, where the tag is authoritative and
# nothing rewrites the files. That is harmless for display-only constants, but
# version.php feeds novalis/package-loader's arbitration: a stale value makes a
# newly released copy advertise an older version and lose to a genuinely older
# bundle on a site running both. Fail loudly instead of shipping that.
set -euo pipefail

VERSION="${1#v}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
	echo "Invalid runtime version: $1" >&2
	exit 1
fi

if [ ! -f "version.php" ]; then
	echo "No version.php; nothing to verify."
	exit 0
fi

ACTUAL="$(php -r 'echo (string) require "version.php";')"

if [ "$ACTUAL" != "$VERSION" ]; then
	echo "::error::version.php reports '$ACTUAL' but this release is '$VERSION'."
	echo "::error::package-loader compares this value across bundled copies — a stale"
	echo "::error::value makes this release lose arbitration to an older bundle."
	echo "::error::Release via workflow_dispatch (which stamps it), or commit the bump."
	exit 1
fi

echo "version.php matches release version ($VERSION)."
