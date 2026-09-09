#!/usr/bin/env bash
# Configure Composer VCS repositories for the package being built/released.
#
# Default profile "from-composer" registers ONLY mirrors needed for packages
# this manifest actually requires (require + require-dev):
#   - builtnorth/* → https://github.com/builtnorth/<slug>.git
#   - other packages that already have a matching vcs/git entry in repositories
#
# It does NOT re-add orphan kitchen-sink repositories left over from older
# release runs (those used to poison composer.json and force auth against
# unrelated private repos).
#
# Profiles:
#   from-composer (default) — derive from required packages only
#   coding-standards-only   — only builtnorth/coding-standards
#   full                    — legacy kitchen-sink (escape hatch only)
#
# Usage: bash configure-composer-vcs-repos.sh [profile]
# Portable: no bash-4 associative arrays (macOS /bin/bash is 3.2).
set -euo pipefail

ORG="${BUILTNORTH_ORG:-builtnorth}"
PROFILE="${1:-from-composer}"

if [ ! -f composer.json ]; then
	echo "No composer.json — skipping VCS repository configuration."
	exit 0
fi

register_url() {
	local key="$1"
	local url="$2"
	if [ -z "$key" ] || [ -z "$url" ]; then
		return 0
	fi
	composer config "repositories.${key}" vcs "$url" 2>/dev/null || true
	echo "  repositories.${key} → ${url}"
}

register_kitchen_sink() {
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
		php-ai-client
	)
	local url
	for repo in "${repos[@]}"; do
		if [ "$repo" = "php-ai-client" ]; then
			url="https://github.com/WordPress/php-ai-client.git"
		else
			url="https://github.com/${ORG}/${repo}.git"
		fi
		register_url "$repo" "$url"
	done
}

# Emit "key<TAB>url" for every required package that needs a VCS mirror.
# Intentionally ignores orphan entries in .repositories that are not required.
collect_from_composer_pairs() {
	jq -r --arg org "$ORG" '
		def required_pkgs:
			((.require // {}) + (.["require-dev"] // {})) | keys;

		def vcs_urls:
			[
				(.repositories // {})
				| if type == "array" then .[] else .[] end
				| select((.type == "vcs") or (.type == "git"))
				| select((.url // "") != "")
				| .url
			];

		def repo_key($url):
			($url | sub("\\.git$"; "") | split("/") | last);

		. as $root
		| required_pkgs[] as $pkg
		| if ($pkg | startswith("builtnorth/")) then
				($pkg | sub("^builtnorth/"; "")) as $repo
				| [$repo, ("https://github.com/" + $org + "/" + $repo + ".git")]
			else
				# Keep an existing VCS URL only when it clearly matches this package
				# (repo name equals the package short name).
				($pkg | split("/") | last) as $short
				| (vcs_urls | map(select(repo_key(.) == $short)) | .[0] // empty) as $url
				| if ($url | length) > 0 then [$short, $url] else empty end
			end
		| @tsv
	' composer.json
}

register_from_composer() {
	local pairs tmp seen key url
	pairs=$(collect_from_composer_pairs || true)

	composer config --unset repositories 2>/dev/null || true

	if [ -z "${pairs}" ]; then
		echo "  (no VCS repositories required)"
		return 0
	fi

	tmp=$(mktemp)
	seen=$(mktemp)
	printf '%s\n' "$pairs" >"$tmp"

	while IFS=$'\t' read -r key url; do
		[ -z "$key" ] && continue
		if grep -qxF "$key" "$seen" 2>/dev/null; then
			continue
		fi
		echo "$key" >>"$seen"
		register_url "$key" "$url"
	done <"$tmp"

	rm -f "$tmp" "$seen"
}

echo "Configuring Composer VCS repositories (profile=${PROFILE})..."

case "$PROFILE" in
	coding-standards-only)
		register_url coding-standards "https://github.com/${ORG}/coding-standards.git"
		;;
	full)
		echo "WARNING: profile=full registers the legacy kitchen-sink VCS list." >&2
		register_kitchen_sink
		;;
	from-composer|"")
		register_from_composer
		;;
	*)
		echo "ERROR: Unknown composer-repository-profile '${PROFILE}'." >&2
		echo "ERROR: Use from-composer (default), coding-standards-only, or full." >&2
		exit 1
		;;
esac
