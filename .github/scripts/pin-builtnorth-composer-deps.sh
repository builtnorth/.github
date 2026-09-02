#!/usr/bin/env bash
# Pin or verify builtnorth/* composer dependencies against latest stable GitHub releases.
set -euo pipefail

ORG="${BUILTNORTH_ORG:-builtnorth}"
MODE="${1:-pin}"

get_latest_stable_tag() {
	local repo="$1"
	local tag

	if [ -z "${GH_TOKEN:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
		GH_TOKEN="$GITHUB_TOKEN"
	fi

	tag=$(gh release list --repo "${ORG}/${repo}" --limit 30 --json tagName,isLatest,isPrerelease \
		-q '.[] | select(.isLatest and (.isPrerelease|not)) | .tagName' 2>/dev/null | head -1)

	if [ -z "$tag" ]; then
		tag=$(gh release list --repo "${ORG}/${repo}" --limit 10 --json tagName,isPrerelease \
			-q '.[] | select(.isPrerelease|not) | .tagName' 2>/dev/null | head -1)
	fi

	echo "$tag"
}

package_to_repo() {
	local pkg="$1"
	echo "${pkg#builtnorth/}"
}

normalize_version() {
	echo "${1#v}"
}

register_builtnorth_vcs_repos() {
	local repos=(
		wp-baseline
		wp-environment-indicator
		wp-utility
		extended-cpts-extras
		wp-schema
		wp-config
		wp-portability
		polaris
		polaris-ai
		polaris-controls
		polaris-integrations-lib
		job-dispatcher
		instant-actions
		coding-standards
	)

	for repo in "${repos[@]}"; do
		composer config "repositories.${repo}" vcs "https://github.com/${ORG}/${repo}.git" 2>/dev/null || true
	done
}

if [ ! -f composer.json ]; then
	echo "No composer.json — skipping builtnorth dependency ${MODE}."
	exit 0
fi

DIRECT_PACKAGES=$(jq -r '.require // {} | keys[]' composer.json | grep '^builtnorth/' || true)

if [ "$MODE" = "pin" ]; then
	if [ -z "$DIRECT_PACKAGES" ]; then
		echo "No direct builtnorth dependencies to pin."
		exit 0
	fi

	register_builtnorth_vcs_repos

	for pkg in $DIRECT_PACKAGES; do
		repo=$(package_to_repo "$pkg")
		tag=$(get_latest_stable_tag "$repo")

		if [ -z "$tag" ]; then
			echo "WARNING: No stable GitHub release found for ${pkg} (${ORG}/${repo})" >&2
			continue
		fi

		version=$(normalize_version "$tag")
		major_minor=$(echo "$version" | sed -E 's/^([0-9]+\.[0-9]+).*/\1/')
		echo "Pinning ${pkg} to ^${major_minor} (latest stable release ${tag})"
		composer require "${pkg}:^${major_minor}" --no-update --no-interaction
	done

	exit 0
fi

if [ "$MODE" = "verify-constraints" ]; then
	if [ -z "$DIRECT_PACKAGES" ]; then
		exit 0
	fi

	register_builtnorth_vcs_repos

	failed=0

	for pkg in $DIRECT_PACKAGES; do
		repo=$(package_to_repo "$pkg")
		latest_tag=$(get_latest_stable_tag "$repo")

		if [ -z "$latest_tag" ]; then
			echo "WARNING: Cannot verify ${pkg} constraint — no stable GitHub release for ${ORG}/${repo}" >&2
			continue
		fi

		constraint=$(jq -r --arg p "$pkg" '.require[$p] // empty' composer.json)
		latest=$(normalize_version "$latest_tag")

		if [ -z "$constraint" ]; then
			echo "FAIL: ${pkg} missing from composer.json require" >&2
			failed=1
			continue
		fi

		tmp_json=$(mktemp)
		cp composer.json "$tmp_json"
		if ! composer require "${pkg}:${latest}" --no-update --no-interaction 2>/dev/null; then
			echo "FAIL: ${pkg} constraint \"${constraint}\" does not allow latest stable v${latest}" >&2
			failed=1
			mv "$tmp_json" composer.json
			continue
		fi
		mv "$tmp_json" composer.json
		echo "OK: ${pkg} constraint \"${constraint}\" allows latest v${latest}"
	done

	if [ "$failed" -ne 0 ]; then
		echo "Release blocked: composer.json constraints block latest builtnorth releases." >&2
		exit 1
	fi

	exit 0
fi

if [ "$MODE" = "verify" ]; then
	if [ ! -f composer.lock ]; then
		echo "FAIL: composer.lock missing — cannot verify builtnorth dependency tree" >&2
		exit 1
	fi

	# Production lock only — dev packages (e.g. coding-standards) are not bundled in releases.
	LOCKED_PACKAGES=$(jq -r '.packages[]? | select(.name | startswith("builtnorth/")) | .name' composer.lock | sort -u)

	if [ -z "$LOCKED_PACKAGES" ]; then
		echo "No builtnorth production packages in composer.lock."
		exit 0
	fi

	failed=0

	for pkg in $LOCKED_PACKAGES; do
		repo=$(package_to_repo "$pkg")
		latest_tag=$(get_latest_stable_tag "$repo")

		if [ -z "$latest_tag" ]; then
			echo "WARNING: Cannot verify ${pkg} — no stable GitHub release for ${ORG}/${repo}" >&2
			continue
		fi

		locked_version=$(jq -r --arg p "$pkg" '.packages[] | select(.name == $p) | .version' composer.lock)
		if [ -z "$locked_version" ] || [ "$locked_version" = "null" ]; then
			echo "FAIL: ${pkg} missing from composer.lock packages" >&2
			failed=1
			continue
		fi

		locked=$(normalize_version "$locked_version")
		latest=$(normalize_version "$latest_tag")

		if [ "$locked" != "$latest" ]; then
			echo "FAIL: ${pkg} locked at v${locked} but GitHub latest stable is v${latest}" >&2
			failed=1
		else
			echo "OK: ${pkg} v${locked} matches GitHub latest"
		fi
	done

	if [ "$failed" -ne 0 ]; then
		echo "Release blocked: builtnorth dependencies are not at latest stable GitHub releases." >&2
		exit 1
	fi

	exit 0
fi

echo "Unknown mode: ${MODE} (use pin or verify)" >&2
exit 1
