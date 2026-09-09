#!/usr/bin/env bash
set -euo pipefail

VERSION="${1#v}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
	echo "Invalid runtime version: $1" >&2
	exit 1
fi

stamped=0

stamp_constant() {
	local file="$1"
	local pattern="$2"

	if [ ! -f "$file" ]; then
		return
	fi

	php -r '
		$file = $argv[1];
		$pattern = $argv[2];
		$version = $argv[3];
		$contents = file_get_contents($file);
		$updated = preg_replace($pattern, "\${1}{$version}\${2}", $contents, 1, $count);
		if (1 !== $count || false === $updated) {
			fwrite(STDERR, "Unable to stamp runtime version in {$file}\n");
			exit(1);
		}
		file_put_contents($file, $updated);
	' "$file" "$pattern" "$VERSION"

	echo "Stamped ${file} with ${VERSION}"
	stamped=1
}

stamp_constant \
	"inc/Core/Constants.php" \
	"/((?:public\s+)?const\s+VERSION\s*=\s*')[^']+(';)/"

stamp_constant \
	"inc/classes/Base/DefineConstants.php" \
	"/('POLARIS_VERSION'\s*=>\s*')[^']+(',)/"

if [ "$stamped" -eq 0 ]; then
	echo "No supported runtime version metadata found; release tag remains authoritative."
fi
