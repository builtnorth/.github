#!/usr/bin/env bash
# Update the private builtnorth/composer index with a newly released package.
#
# Usage:
#   update-composer-index.sh <composer-namespace> <version>
#   e.g. update-composer-index.sh builtnorth/instant-actions 2.0.1
#
# Environment:
#   GH_TOKEN  — PAT with repo scope across all builtnorth/* repos (required)
#
# The script clones builtnorth/composer to a temp dir, appends the new version
# entry to packages.json, commits and pushes. It retries up to 5 times on push
# conflicts (parallel release jobs writing simultaneously).
set -euo pipefail

PACKAGE="${1:-}"
VERSION="${2:-}"

if [ -z "$PACKAGE" ] || [ -z "$VERSION" ]; then
	echo "Usage: update-composer-index.sh <composer-namespace> <version>" >&2
	exit 1
fi

if [ -z "${GH_TOKEN:-}" ]; then
	echo "GH_TOKEN is required." >&2
	exit 1
fi

ORG="${BUILTNORTH_ORG:-builtnorth}"
SLUG="${PACKAGE#${ORG}/}"
TAG="v${VERSION#v}"
INDEX_REPO="${ORG}/composer"
TMPDIR="$(mktemp -d)"
INDEX_PATH="${TMPDIR}/composer-index"

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

echo "Updating Composer index: ${PACKAGE}@${VERSION}"

# ---------------------------------------------------------------------------
# 1. Clone the index repo (shallow, main only)
# ---------------------------------------------------------------------------
git clone --quiet --depth 1 \
	"https://x-access-token:${GH_TOKEN}@github.com/${INDEX_REPO}.git" \
	"$INDEX_PATH"

cd "$INDEX_PATH"
git config user.name  "GitHub Actions"
git config user.email "action@github.com"

# ---------------------------------------------------------------------------
# 2. Fetch release metadata from GitHub API
# ---------------------------------------------------------------------------
echo "Fetching release metadata for ${ORG}/${SLUG}@${TAG}..."

RELEASE=$(gh api "repos/${ORG}/${SLUG}/releases/tags/${TAG}" 2>/dev/null || echo "")

if [ -z "$RELEASE" ]; then
	echo "Warning: release ${TAG} not found on ${ORG}/${SLUG}; skipping index update." >&2
	exit 0
fi

# Get the tag's commit SHA (handle annotated and lightweight tags)
COMMIT=$(gh api "repos/${ORG}/${SLUG}/git/ref/tags/${TAG}" --jq '.object.sha' 2>/dev/null || echo "")
if [ -z "$COMMIT" ]; then
	COMMIT=$(gh api "repos/${ORG}/${SLUG}/commits?sha=${TAG}&per_page=1" --jq '.[0].sha' 2>/dev/null || echo "")
fi
# Resolve annotated tag to the underlying commit
OBJECT_TYPE=$(gh api "repos/${ORG}/${SLUG}/git/ref/tags/${TAG}" --jq '.object.type' 2>/dev/null || echo "commit")
if [ "$OBJECT_TYPE" = "tag" ]; then
	COMMIT=$(gh api "repos/${ORG}/${SLUG}/git/tags/${COMMIT}" --jq '.object.sha' 2>/dev/null || echo "$COMMIT")
fi

# Zip asset URL — prefer the release asset, fall back to the conventional URL
ASSET_URL=$(echo "$RELEASE" | jq -r \
	--arg slug "$SLUG" --arg ver "$VERSION" \
	'.assets[] | select(.name == "\($slug)-\($ver).zip") | .browser_download_url' \
	2>/dev/null | head -1)
if [ -z "$ASSET_URL" ]; then
	ASSET_URL="https://github.com/${ORG}/${SLUG}/releases/download/${TAG}/${SLUG}-${VERSION}.zip"
fi

# Fetch composer.json from the tag to include require/autoload metadata
RAW_COMPOSER=$(gh api "repos/${ORG}/${SLUG}/contents/composer.json?ref=${TAG}" \
	--jq '.content' 2>/dev/null | base64 -d 2>/dev/null || echo "{}")

PKG_TYPE=$(echo "$RAW_COMPOSER"    | jq -r '.type        // "library"')
PKG_DESC=$(echo "$RAW_COMPOSER"    | jq -r '.description // ""')
PKG_REQUIRE=$(echo "$RAW_COMPOSER" | jq '.require        // {}')
PKG_AUTOLOAD=$(echo "$RAW_COMPOSER"| jq '.autoload       // {}')

# Normalised semver: x.y.z → x.y.z.0
VERSION_NORM="${VERSION}.0"

# ---------------------------------------------------------------------------
# 3. Initialise packages.json if the repo is empty
# ---------------------------------------------------------------------------
if [ ! -f packages.json ]; then
	echo '{"packages":{}}' > packages.json
fi

# ---------------------------------------------------------------------------
# 4. Merge the new entry into packages.json
# ---------------------------------------------------------------------------
jq \
	--arg  pkg       "$PACKAGE" \
	--arg  ver       "$VERSION" \
	--arg  ver_norm  "$VERSION_NORM" \
	--arg  type      "$PKG_TYPE" \
	--arg  desc      "$PKG_DESC" \
	--argjson require  "$PKG_REQUIRE" \
	--argjson autoload "$PKG_AUTOLOAD" \
	--arg  zip_url   "$ASSET_URL" \
	--arg  commit    "$COMMIT" \
	--arg  repo_url  "https://github.com/${ORG}/${SLUG}.git" \
	'.packages[$pkg][$ver] = {
		"name":               $pkg,
		"version":            $ver,
		"version_normalized": $ver_norm,
		"type":               $type,
		"description":        $desc,
		"require":            $require,
		"autoload":           $autoload,
		"dist": {
			"type":      "zip",
			"url":       $zip_url,
			"reference": $commit,
			"shasum":    ""
		},
		"source": {
			"type":      "git",
			"url":       $repo_url,
			"reference": $commit
		}
	}' packages.json > packages.json.tmp && mv packages.json.tmp packages.json

echo "packages.json updated — ${PACKAGE}@${VERSION} added."

# ---------------------------------------------------------------------------
# 5. Commit and push (retry up to 5 times on push conflicts)
# ---------------------------------------------------------------------------
git add packages.json

if git diff --cached --quiet; then
	echo "${PACKAGE}@${VERSION} already in index; nothing to commit."
	exit 0
fi

git commit -m "chore: index ${PACKAGE} ${VERSION}"

MAX_RETRIES=5
for attempt in $(seq 1 $MAX_RETRIES); do
	if git push origin main; then
		echo "Index updated successfully."
		exit 0
	fi
	echo "Push failed (attempt ${attempt}/${MAX_RETRIES}); rebasing and retrying..."
	git fetch origin main
	git rebase origin/main
done

echo "Failed to push after ${MAX_RETRIES} attempts." >&2
exit 1
