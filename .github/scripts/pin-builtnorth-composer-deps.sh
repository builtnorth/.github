#!/usr/bin/env bash
# Prepare and verify builtnorth/* Composer dependencies without changing
# committed version constraints.
set -euo pipefail

MODE="${1:-prepare}"

configure_builtnorth_repository() {
	local script_dir
	script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	# Inject the private package index globally without changing composer.json.
	bash "${script_dir}/configure-composer-vcs-repos.sh" from-composer
}

if [ ! -f composer.json ]; then
	echo "No composer.json — skipping builtnorth dependency ${MODE}."
	exit 0
fi

DIRECT_PACKAGES=$(jq -r '.require // {} | keys[]' composer.json | grep '^builtnorth/' || true)

case "$MODE" in
	prepare|pin)
		if [ "$MODE" = "pin" ]; then
			echo "WARNING: mode=pin is deprecated; preserving committed constraints." >&2
		fi

		configure_builtnorth_repository

		if [ -z "$DIRECT_PACKAGES" ]; then
			echo "No direct builtnorth production dependencies."
			exit 0
		fi

		echo "Committed builtnorth dependency constraints:"
		jq -r '
			.require // {}
			| to_entries[]
			| select(.key | startswith("builtnorth/"))
			| "  \(.key): \(.value)"
		' composer.json
		echo "Composer will resolve the newest released versions allowed by these constraints."
		;;
	validate|verify-constraints)
		if [ "$MODE" = "verify-constraints" ]; then
			echo "WARNING: mode=verify-constraints is deprecated; validating committed constraints." >&2
		fi
		composer validate --no-check-lock --no-check-publish --no-interaction
		;;
	verify)
		if [ ! -f composer.lock ]; then
			echo "FAIL: composer.lock missing — cannot verify the production dependency tree." >&2
			exit 1
		fi

		composer validate --check-lock --no-check-publish --no-interaction
		composer install --dry-run --no-dev --no-scripts --no-interaction

		LOCKED_PACKAGES=$(jq -r '
			.packages[]?
			| select(.name | startswith("builtnorth/"))
			| "  \(.name): \(.version)"
		' composer.lock)

		if [ -z "$LOCKED_PACKAGES" ]; then
			echo "No builtnorth production packages in composer.lock."
		else
			echo "Resolved builtnorth production dependencies:"
			echo "$LOCKED_PACKAGES"
		fi
		;;
	*)
		echo "Unknown mode: ${MODE} (use prepare, validate, or verify)" >&2
		exit 1
		;;
esac
