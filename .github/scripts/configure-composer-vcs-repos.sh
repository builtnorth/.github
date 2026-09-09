#!/usr/bin/env bash
# Configure first-party package resolution without mutating the project manifest.
#
# The private Composer index (builtnorth/registry) is public — packages.json
# contains only package names, versions, and release download URLs, no secrets.
# Auth is only needed for the actual dist downloads from private plugin repos.
set -euo pipefail

ORG="${BUILTNORTH_ORG:-builtnorth}"
PROFILE="${1:-from-composer}"
INDEX_URL="${BUILTNORTH_COMPOSER_INDEX_URL:-https://raw.githubusercontent.com/builtnorth/registry/main}"

register_index() {
	local auth token
	auth="${COMPOSER_AUTH:-}"
	token=""
	if [ -n "$auth" ]; then
		token="$(printf '%s' "$auth" | jq -r '.["github-oauth"]["github.com"] // empty')"
	fi

	# The index itself is public — no auth needed to fetch packages.json.
	composer config --global repositories.builtnorth composer "$INDEX_URL"

	if [ -n "$token" ]; then
		# github-oauth is only sent for api.github.com URLs. Private GitHub
		# release zips (github.com/.../releases/download/...) need http-basic
		# with username x-access-token or GitHub returns 404, not 401.
		composer config --global --auth github-oauth.github.com "$token"
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
