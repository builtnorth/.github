#!/usr/bin/env bash
# Configure first-party package resolution without mutating the project manifest.
#
# The private Composer index is the single source for released builtnorth/*
# packages. Project composer.json files declare dependencies only; CI injects
# repository configuration globally on its ephemeral runner.
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
		composer config --global --auth http-basic.raw.githubusercontent.com x-access-token "$token"
		# api.github.com — dist.url entries for libraries use the GitHub API
		# zipball endpoint which requires its own http-basic credential.
		composer config --global --auth http-basic.api.github.com x-access-token "$token"
		# github.com — dist.url entries for plugins use direct release download
		# URLs (github.com/releases/download/...) which also require auth on
		# private repos.
		composer config --global --auth http-basic.github.com x-access-token "$token"
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
