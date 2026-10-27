#!/usr/bin/env bash
# Fetch a project's Composer dependencies with the org token, for jobs that get no token.
#
# Usage (from the project root): fetch-private-deps.sh <out-dir> [composer-repository-profile]
# Needs COMPOSER_AUTH with github-oauth.github.com set.
#
# The token may only sit in a job that runs first-party code: anything else in the job can
# read it (runner memory, ~/.config/composer/auth.json). So this runs Composer with
# --no-plugins and --no-scripts, keeps Composer's home (where the token is written) out of
# <out-dir>, and leaves in <out-dir> only:
#   composer.lock   the committed lock, or one resolved here (config.platform.php applies)
#   cache/files/    every dist, keyed as a plain `composer install` will look for it
# A token-free job then copies the lock if it has none, points COMPOSER_CACHE_DIR at
# <out-dir>/cache and runs a normal `composer install`, plugins and scripts included.
set -euo pipefail

OUT="${1:?usage: fetch-private-deps.sh <out-dir> [profile]}"
PROFILE="${2:-from-composer}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TOKEN="$(printf '%s' "${COMPOSER_AUTH:-}" | jq -r '.["github-oauth"]["github.com"] // empty')"
if [ -z "$TOKEN" ]; then
	echo "ERROR: COMPOSER_AUTH github-oauth.github.com is empty." >&2
	exit 1
fi

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
export COMPOSER_HOME="${RUNNER_TEMP:-/tmp}/fetch-composer-home"
export COMPOSER_CACHE_DIR="$OUT/cache"
export COMPOSER_NO_INTERACTION=1

bash "$SCRIPT_DIR/configure-composer-vcs-repos.sh" "$PROFILE"

# Extensions are the test jobs' concern; the PHP version still comes from config.platform.
PLATFORM=(--ignore-platform-req='ext-*')

if [ ! -f composer.lock ]; then
	composer update --no-install --no-plugins --no-scripts --no-progress "${PLATFORM[@]}"
fi

# Downloads every dist into the cache. vendor/ here is thrown away with the job.
composer install --prefer-dist --no-plugins --no-scripts --no-autoloader --no-progress "${PLATFORM[@]}"

cp composer.lock "$OUT/composer.lock"
# Only the dist files: repo/ and vcs/ can hold authenticated URLs.
find "$COMPOSER_CACHE_DIR" -mindepth 1 -maxdepth 1 ! -name files -exec rm -rf {} +

# Never hand the token on.
BASIC="$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')"
if grep -rqF -e "$TOKEN" -e "$BASIC" "$OUT"; then
	echo "ERROR: the fetched dependencies contain the token; refusing to upload them." >&2
	exit 1
fi

echo "Fetched: $(find "$OUT/cache/files" -type f 2>/dev/null | wc -l | tr -d ' ') dist files, composer.lock"
