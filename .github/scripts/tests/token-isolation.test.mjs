// A job that references the org token must not run third-party code: anything in the job can
// read every secret it references (runner memory, files the job writes). Such a job may only
// check out, run our own scripts with the runner's tools, and move artifacts. Composer runs
// only inside those scripts, always with --no-plugins and --no-scripts.
//
// Only workflows already split that way are listed; add each one as it is converted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const GITHUB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOWS_DIR = path.join(GITHUB_DIR, "workflows");
const SCRIPTS_DIR = path.join(GITHUB_DIR, "scripts");

// Workflow → the jobs allowed to hold the token. Each of them is checked below.
const ISOLATED = {
	"wp-plugin-ci.yml": ["fetch"],
	"composer-package-ci.yml": ["fetch"],
	"npm-package-ci.yml": ["fetch"],
	"sync-starter.yml": ["fetch", "publish"],
};

// Any way a job can receive the token: by name, all secrets at once, or passed down.
const TOKEN = /ORG_REPO_TOKEN|WORKFLOW_TOKEN|toJSON\(\s*secrets\s*\)|secrets:\s*inherit/;
const ALLOWED_ACTIONS = /^(actions\/checkout|actions\/upload-artifact|actions\/download-artifact)@/;
const THIRD_PARTY = [
	[/\b(npm|npx|yarn|pnpm|bun|pip3?|pipx)\b/, "a package manager"],
	[/\bcurl\b[^\n]*\|\s*(ba|z)?sh\b/, "a downloaded script"],
	[/\bphp\s+\S*vendor\//, "vendor code"],
	[/vendor\/bin\//, "vendor/bin tools"],
	[/\bnode\s+\S*node_modules\//, "node_modules code"],
	[/\bwp-env\b/, "wp-env"],
	[/\bplaywright\b/i, "Playwright"],
	[/\bgh\s+extension\b/, "a gh extension"],
];

/** Lines that run, without comments. */
function code(text) {
	return text
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
}

/** Top-level jobs of a workflow file as { name, body }, split on two-space job keys. */
function jobs(source) {
	const lines = source.split("\n");
	const start = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line));
	assert.notEqual(start, -1, "workflow has a jobs: block");
	const found = [];
	for (const line of lines.slice(start + 1)) {
		const key = /^  ([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
		if (key) {
			found.push({ name: key[1], body: [] });
		} else if (found.length) {
			found[found.length - 1].body.push(line);
		}
	}
	return found.map(({ name, body }) => ({ name, body: code(body.join("\n")) }));
}

/** Our scripts a body runs (.github/scripts/<name>.sh), followed through SCRIPT_DIR calls. */
function scriptsRun(body, seen = new Set()) {
	for (const [, , name] of body.matchAll(/(\.github\/scripts\/|\$SCRIPT_DIR\/)([A-Za-z0-9_-]+\.sh)/g)) {
		if (seen.has(name)) continue;
		seen.add(name);
		const file = path.join(SCRIPTS_DIR, name);
		assert.ok(existsSync(file), `script ${name} exists`);
		scriptsRun(readFileSync(file, "utf8"), seen);
	}
	return seen;
}

function assertNoThirdParty(text, where) {
	for (const [pattern, label] of THIRD_PARTY) {
		assert.doesNotMatch(text, pattern, `${where} holds the org token and runs ${label}`);
	}
}

for (const [file, tokenJobNames] of Object.entries(ISOLATED)) {
	const source = readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
	const tokenJobs = jobs(source).filter((job) => TOKEN.test(job.body));

	test(`${file}: only ${tokenJobNames.join(" and ")} hold the org token`, () => {
		assert.deepEqual(
			tokenJobs.map((job) => job.name),
			tokenJobNames,
		);
	});

	test(`${file}: the token job runs no third-party code`, () => {
		for (const job of tokenJobs) {
			const where = `${file} job "${job.name}"`;
			assertNoThirdParty(job.body, where);
			assert.doesNotMatch(job.body, /\bcomposer\s+[a-z]/, `${where} holds the org token and runs Composer outside our scripts`);
			for (const [, action] of job.body.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
				assert.match(action, ALLOWED_ACTIONS, `${where} holds the org token and uses ${action}`);
			}
		}
	});

	test(`${file}: scripts the token job runs keep Composer plugins and scripts off`, () => {
		for (const job of tokenJobs) {
			for (const name of scriptsRun(job.body)) {
				const body = code(readFileSync(path.join(SCRIPTS_DIR, name), "utf8"));
				const where = `${name} (run by ${file} job "${job.name}")`;
				assertNoThirdParty(body, where);
				for (const [call] of body.matchAll(/\bcomposer\s+(?!config\b)[a-z][^\n]*/g)) {
					assert.match(call, /--no-plugins/, `${where}: "${call.trim()}" must pass --no-plugins`);
					assert.match(call, /--no-scripts/, `${where}: "${call.trim()}" must pass --no-scripts`);
				}
			}
		}
	});
}
