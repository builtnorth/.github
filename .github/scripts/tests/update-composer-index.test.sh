#!/usr/bin/env bash
# The index entry is keyed by the Composer name, while release metadata comes
# from the GitHub repo, which can differ (navas/utility lives in builtnorth/utility).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

STUB_BIN="${FIXTURE_DIR}/bin"
mkdir -p "$STUB_BIN"
export INDEX_OUT="${FIXTURE_DIR}/packages.json"
export GH_LOG="${FIXTURE_DIR}/gh.log"

# git: "clone" makes an empty index checkout; "push" saves packages.json.
cat >"${STUB_BIN}/git" <<'SH'
#!/usr/bin/env bash
case "$1" in
	clone) mkdir -p "${@: -1}" ;;
	push) cp packages.json "$INDEX_OUT" ;;
	diff) exit 1 ;;
	*) ;;
esac
SH

# gh: answers only for builtnorth/utility; anything else is "not found".
cat >"${STUB_BIN}/gh" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"$GH_LOG"
path="$2"
case "$path" in
	repos/builtnorth/utility/releases/tags/v1.2.3) echo '{"assets":[]}' ;;
	repos/builtnorth/utility/git/ref/tags/v1.2.3)
		if [[ "$*" == *object.type* ]]; then echo commit; else echo abc123; fi ;;
	repos/builtnorth/utility/contents/composer.json*)
		printf '%s' '{"name":"navas/utility","type":"library"}' | base64 ;;
	*) exit 1 ;;
esac
SH
chmod +x "${STUB_BIN}/git" "${STUB_BIN}/gh"
export PATH="${STUB_BIN}:${PATH}"
export GH_TOKEN="test"

bash "${SCRIPT_DIR}/update-composer-index.sh" navas/utility 1.2.3 utility >/dev/null

name="$(jq -r '.packages["navas/utility"]["1.2.3"].name' "$INDEX_OUT")"
url="$(jq -r '.packages["navas/utility"]["1.2.3"].source.url' "$INDEX_OUT")"
if [ "$name" != "navas/utility" ] || [ "$url" != "https://github.com/builtnorth/utility.git" ]; then
	echo "FAIL: expected navas/utility indexed from builtnorth/utility, got name=${name} url=${url}" >&2
	exit 1
fi

# A release that can't be found fails instead of skipping the index silently.
if bash "${SCRIPT_DIR}/update-composer-index.sh" navas/missing 1.2.3 missing >/dev/null 2>&1; then
	echo "FAIL: a missing release must fail the index update." >&2
	exit 1
fi

echo "PASS: update-composer-index keys by Composer name and reads the given repo."
