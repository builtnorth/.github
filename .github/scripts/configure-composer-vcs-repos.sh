#!/usr/bin/env bash
# Configure first-party package resolution without mutating the project manifest.
#
# The private Composer index is the single source for released builtnorth/*
# packages. Project composer.json files declare dependencies only; CI injects
# repository configuration globally on its ephemeral runner.
#
# Auth strategy: COMPOSER_AUTH env var always overrides auth.json at runtime.
# We therefore write ALL auth domains into auth.json via `composer config --global --auth`
# AND export an updated COMPOSER_AUTH that includes all domains so downstream
# steps (which set their own COMPOSER_AUTH) don't silently lose the credentials
# we configure here.
set -euo pipefail

ORG="${BUILTNORTH_ORG:-builtnorth}"
PROFILE="${1:-from-composer}"
INDEX_URL="${BUILTNORTH_COMPOSER_INDEX_URL:-https://raw.githubusercontent.com/builtnorth/composer/main}"

register_index() {
	local auth token
	auth="${COMPOSER_AUTH:-}"
	token=""
	if [ -n "$auth" ]; then
		token="$(printf '%s' "$auth" | jq -r '.["github-oauth"]["github.com"] // empty')"
	fi

	composer config --global repositories.builtnorth composer "$INDEX_URL"

	if [ -n "$token" ]; then
		# Write all auth domains to global auth.json.
		composer config --global --auth http-basic.raw.githubusercontent.com x-access-token "$token"
		composer config --global --auth http-basic.api.github.com x-access-token "$token"
		# github.com — dist.url entries for plugins use direct release download URLs.
		composer config --global --auth http-basic.github.com x-access-token "$token"

		# Build a single-line JSON with all auth domains. COMPOSER_AUTH env var
		# overrides auth.json at runtime, so downstream steps must carry all
		# domains — not just github-oauth.
		MERGED_AUTH="$(jq -cn \
			--arg token "$token" \
			'{"github-oauth":{"github.com":$token},"http-basic":{"raw.githubusercontent.com":{"username":"x-access-token","password":$token},"api.github.com":{"username":"x-access-token","password":$token},"github.com":{"username":"x-access-token","password":$token}}}')"
		export COMPOSER_AUTH="$MERGED_AUTH"

		# Propagate to subsequent GitHub Actions steps via GITHUB_ENV if available.
		# GITHUB_ENV requires single-line values; jq -c above guarantees that.
		if [ -n "${GITHUB_ENV:-}" ]; then
			printf 'COMPOSER_AUTH=%s\n' "$MERGED_AUTH" >> "$GITHUB_ENV"
		fi
	fi

	echo "  repositories.builtnorth → ${INDEX_URL}"
}

register_coding_standards() {
	composer config --global repositories.coding-standards vcs "https://github.com/${ORG}/coding-standards.git"
	echo "  repositories.coding-standards → https://github.com/${ORG}/coding-standards.git"
}

echo "Configuring Composer repositories (profile=${PROFILE})..."

case "$PROFILE" in
	coding-standards-only)
		register_coding_standards
		;;
	full)
		echo "WARNING: profile=full is deprecated; using the private Composer index." >&2
		register_index
		register_coding_standards
		;;
	from-composer|"")
		register_index
		;;
	*)
		echo "ERROR: Unknown composer-repository-profile '${PROFILE}'." >&2
		echo "ERROR: Use from-composer (default), coding-standards-only, or full." >&2
		exit 1
		;;
esac
