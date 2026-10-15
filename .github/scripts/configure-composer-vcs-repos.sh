#!/usr/bin/env bash
# Configure first-party package resolution without mutating the project manifest.
#
# The Composer index (builtnorth/registry) is a private repo. Reading it needs
# the same token as the private package downloads: git ls-remote and
# packages.json on raw.githubusercontent.com both authenticate with it.
set -euo pipefail

ORG="${BUILTNORTH_ORG:-builtnorth}"
PROFILE="${1:-from-composer}"

TOKEN=""
if [ -n "${COMPOSER_AUTH:-}" ]; then
	TOKEN="$(printf '%s' "$COMPOSER_AUTH" | jq -r '.["github-oauth"]["github.com"] // empty')"
fi

# Read the index at its latest commit, not `main`: raw.githubusercontent.com
# caches branch URLs for minutes, so a package released moments earlier in the
# same release run would be invisible to this one. A commit URL is never stale.
INDEX_SHA=""
if [ -n "$TOKEN" ]; then
	INDEX_SHA="$(git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')" \
		ls-remote "https://github.com/${ORG}/registry.git" refs/heads/main 2>/dev/null | cut -f1)"
fi
INDEX_URL="${BUILTNORTH_COMPOSER_INDEX_URL:-https://raw.githubusercontent.com/${ORG}/registry/${INDEX_SHA:-main}}"

register_index() {
	if [ -z "$TOKEN" ]; then
		echo "ERROR: COMPOSER_AUTH github-oauth.github.com is empty." >&2
		echo "ERROR: The index and private package dists need a GitHub token; Composer" >&2
		echo "ERROR: only sends GitHub OAuth when the token is keyed as github.com." >&2
		exit 1
	fi

	composer config --global repositories.builtnorth composer "$INDEX_URL"
	# packages.json lives in a private repo: raw.githubusercontent.com takes the
	# token as basic auth. A separate host, so it can't clash with github-oauth.
	composer config --global --auth http-basic.raw.githubusercontent.com x-access-token "$TOKEN"

	# Composer AuthHelper sends "Authorization: token" only when:
	#   origin github.com, password x-oauth-basic, URL is api.github.com.
	# It remaps origin api.github.com → github.com when github.com is NOT
	# already authenticated under a different scheme.
	# Do NOT set github-oauth.api.github.com (sends broken Basic auth).
	# Do NOT set http-basic.github.com (overwrites x-oauth-basic).
	composer config --global --unset http-basic.github.com >/dev/null 2>&1 || true
	composer config --global --unset github-oauth.api.github.com >/dev/null 2>&1 || true
	composer config --global --auth github-oauth.github.com "$TOKEN"

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
