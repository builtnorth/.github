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

	if [ -z "$token" ]; then
		echo "ERROR: COMPOSER_AUTH github-oauth.github.com is empty." >&2
		echo "ERROR: Private package dist is api.github.com zipballs; Composer only" >&2
		echo "ERROR: sends GitHub OAuth when the token is keyed as github.com." >&2
		exit 1
	fi

	# Composer AuthHelper sends "Authorization: token" only when:
	#   origin github.com, password x-oauth-basic, URL is api.github.com.
	# It remaps origin api.github.com → github.com when github.com is NOT
	# already authenticated under a different scheme.
	# Do NOT set github-oauth.api.github.com (sends broken Basic auth).
	# Do NOT set http-basic.github.com (overwrites x-oauth-basic).
	composer config --global --unset http-basic.github.com >/dev/null 2>&1 || true
	composer config --global --unset github-oauth.api.github.com >/dev/null 2>&1 || true
	composer config --global --auth github-oauth.github.com "$token"

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
