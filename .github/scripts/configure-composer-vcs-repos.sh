#!/usr/bin/env bash
# Configure Composer VCS repositories for the package being built/released.
#
# Default profile "from-composer" registers ONLY:
#   1) vcs/git entries already declared in this package's composer.json
#   2) a GitHub VCS mirror for every builtnorth/* require / require-dev
#
# That avoids the old kitchen-sink "full" list, which forced Composer to
# authenticate against unrelated private repos during composer update.
#
# Profiles:
#   from-composer (default) — derive from this package's composer.json
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

repo_key_from_url() {
	local url="$1"
	# https://github.com/org/repo.git → repo
	echo "$url" | sed -E 's#\.git$##' | sed -E 's#.*/##'
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

# Emit "key<TAB>url" lines for every VCS mirror this package needs.
collect_from_composer_pairs() {
	jq -r '
		def repo_key($url):
			($url | sub("\\.git$"; "") | split("/") | last);

		[
			(
				(.repositories // {})
				| if type == "array" then .[] else .[] end
				| select((.type == "vcs") or (.type == "git"))
				| select((.url // "") != "")
				| [repo_key(.url), .url]
			),
			(
				((.require // {}) + (.["require-dev"] // {}))
				| to_entries[]
				| select(.key | startswith("builtnorth/"))
				| .key as $pkg
				| ($pkg | sub("^builtnorth/"; "")) as $repo
				| [$repo, ("https://github.com/" + env.ORG + "/" + $repo + ".git")]
			)
		]
		| .[]
		| @tsv
	' composer.json
}

register_from_composer() {
	# Rewrite repositories to exactly the derived set (drops leftover numeric
	# keys from array-form composer.json; never adds unrelated private repos).
	local pairs tmp seen key url
	pairs=$(ORG="$ORG" collect_from_composer_pairs || true)

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
