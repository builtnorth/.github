#!/usr/bin/env bash
# Configure first-party package resolution without mutating the project manifest.
#
# The private Composer index is the single source for released builtnorth/*
# packages. Project composer.json files declare dependencies only; CI injects
# repository configuration globally on its ephemeral runner.
#
# Auth strategy: use github-oauth for all GitHub domains. Composer natively
# understands github-oauth for github.com, raw.githubusercontent.com, and
# api.github.com — no http-basic needed, no conflict warnings.
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
		# Register the token as github-oauth for all GitHub-served domains.
		# github-oauth is Composer's native auth type for GitHub; it works for
		# github.com, raw.githubusercontent.com, and api.github.com without
		# conflict warnings. http-basic is not needed.
		composer config --global --auth github-oauth.raw.githubusercontent.com "$token"
		composer config --global --auth github-oauth.api.github.com "$token"

		# Propagate updated auth to subsequent steps. GITHUB_ENV requires
		# single-line values; jq -c guarantees compact output.
		if [ -n "${GITHUB_ENV:-}" ]; then
			MERGED_AUTH="$(jq -cn \
				--arg token "$token" \
				'{"github-oauth":{"github.com":$token,"raw.githubusercontent.com":$token,"api.github.com":$token}}')"
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
