#!/usr/bin/env bash
# Backfill the builtnorth/composer private index with every released version
# of every composer-type package in the release catalog.
#
# Run this once to bootstrap the index after the new update-composer-index.sh
# mechanism is in place. Future releases will keep it current automatically.
#
# Usage:
#   GH_TOKEN=<pat> bash backfill-composer-index.sh [--dry-run]
#
# Options:
#   --dry-run   Print what would be indexed without writing anything.
#
# Requirements: gh, jq, git
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CATALOG="${SCRIPT_DIR}/../release-packages.json"
DRY_RUN=false

for arg in "$@"; do
	[ "$arg" = "--dry-run" ] && DRY_RUN=true
done

if [ -z "${GH_TOKEN:-}" ]; then
	echo "GH_TOKEN is required." >&2
	exit 1
fi

if [ ! -f "$CATALOG" ]; then
	echo "Catalog not found at ${CATALOG}" >&2
	exit 1
fi

ORG="${BUILTNORTH_ORG:-builtnorth}"

# Read all composer-type package slugs from the catalog
PACKAGES=$(jq -r '.packages[] | select(.type == "composer") | .slug' "$CATALOG")

echo "Backfilling Composer index for packages:"
echo "$PACKAGES" | sed 's/^/  /'
echo ""

SUCCESS=0
SKIPPED=0
FAILED=0

for SLUG in $PACKAGES; do
	PACKAGE="${ORG}/${SLUG}"
	echo "=== ${PACKAGE} ==="

	# Fetch all releases for this package (newest first, up to 100)
	RELEASES=$(gh api "repos/${ORG}/${SLUG}/releases?per_page=100" \
		--jq '[.[] | select(.prerelease == false and .draft == false) | .tag_name]' \
		2>/dev/null || echo "[]")

	if [ "$RELEASES" = "[]" ] || [ -z "$RELEASES" ]; then
		echo "  No releases found, skipping."
		SKIPPED=$((SKIPPED + 1))
		continue
	fi

	VERSIONS=$(echo "$RELEASES" | jq -r '.[]' | sed 's/^v//')
	echo "  Found releases: $(echo "$VERSIONS" | tr '\n' ' ')"

	for VERSION in $VERSIONS; do
		if $DRY_RUN; then
			echo "  [dry-run] Would index ${PACKAGE}@${VERSION}"
			continue
		fi

		echo "  Indexing ${VERSION}..."
		if bash "$SCRIPT_DIR/update-composer-index.sh" "$PACKAGE" "$VERSION"; then
			SUCCESS=$((SUCCESS + 1))
		else
			echo "  WARNING: failed to index ${PACKAGE}@${VERSION}" >&2
			FAILED=$((FAILED + 1))
		fi
	done
done

echo ""
echo "Backfill complete."
echo "  Indexed: ${SUCCESS}"
echo "  Skipped: ${SKIPPED} (no releases)"
echo "  Failed:  ${FAILED}"

[ "$FAILED" -eq 0 ] || exit 1
