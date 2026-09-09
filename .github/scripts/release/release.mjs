#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG = path.resolve(SCRIPT_DIR, "../../release-packages.json");
const TAG_INTERVAL_MS = 90_000;
const TAG_TIMEOUT_MS = 45 * 60_000;

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
	}).trim();
}

function git(cwd, args) {
	return run("git", args, { cwd });
}

function parseVersion(value) {
	const match = String(value || "").match(
		/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/,
	);
	return match
		? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)]
		: null;
}

function compareVersions(left, right) {
	const a = parseVersion(left);
	const b = parseVersion(right);
	if (!a || !b) return 0;
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return a[index] - b[index];
	}
	return 0;
}

function satisfiesComparator(version, comparator) {
	const match = comparator.match(/^(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/);
	if (!match) return false;
	const targetParts = match[2].split(".").map(Number);
	while (targetParts.length < 3) targetParts.push(0);
	const comparison = compareVersions(version, targetParts.join("."));
	switch (match[1] || "=") {
		case ">=":
			return comparison >= 0;
		case "<=":
			return comparison <= 0;
		case ">":
			return comparison > 0;
		case "<":
			return comparison < 0;
		default:
			return comparison === 0;
	}
}

export function constraintAllows(constraint, version) {
	const parsed = parseVersion(version);
	if (!parsed) return false;
	const value = String(constraint || "").trim();
	if (!value || value === "*" || value.toLowerCase() === "latest") return true;

	return value.split(/\s*\|\|?\s*/).some((alternative) => {
		const range = alternative.trim();
		if (!range) return false;

		if (range.startsWith("^") || range.startsWith("~")) {
			const operator = range[0];
			const base = parseVersion(range.slice(1));
			if (!base || compareVersions(version, base.join(".")) < 0) return false;
			if (operator === "~") {
				return parsed[0] === base[0] && parsed[1] === base[1];
			}
			if (base[0] > 0) return parsed[0] === base[0];
			if (base[1] > 0) return parsed[0] === 0 && parsed[1] === base[1];
			return parsed[0] === 0 && parsed[1] === 0 && parsed[2] === base[2];
		}

		if (/[*xX]/.test(range)) {
			const expected = range.replace(/^v/, "").split(".");
			return expected.every(
				(part, index) => /[*xX]/.test(part) || Number(part) === parsed[index],
			);
		}

		const comparators = range.match(/(?:>=|<=|>|<|=)?\s*v?\d+(?:\.\d+){0,2}/g);
		return comparators?.length
			? comparators.every((item) => satisfiesComparator(version, item.trim()))
			: false;
	});
}

export function bumpVersion(version, bump = "patch") {
	const parsed = parseVersion(version) || [0, 0, 0];
	if (bump === "major") return `${parsed[0] + 1}.0.0`;
	if (bump === "minor") return `${parsed[0]}.${parsed[1] + 1}.0`;
	return `${parsed[0]}.${parsed[1]}.${parsed[2] + 1}`;
}

export function classifyCommits(messages) {
	const text = messages.join("\n");
	if (/(^|\n)\w+(\([^)]*\))?!:|BREAKING CHANGE:/i.test(text)) return "major";
	if (/(^|\n)feat(\([^)]*\))?:/i.test(text)) return "minor";
	return "patch";
}

function addEdge(node, dependency, kind, constraint) {
	if (node.dependencies.some((edge) => edge.node === dependency && edge.kind === kind)) {
		return;
	}
	node.dependencies.push({ node: dependency, kind, constraint });
	dependency.dependents.push({ node, kind, constraint });
}

export function loadGraph(catalogFile = DEFAULT_CATALOG) {
	const catalog = readJson(catalogFile);
	const nodes = catalog.packages.map((entry) => ({
		...entry,
		repo: entry.repo || `builtnorth/${entry.slug}`,
		developmentBranch: entry.developmentBranch || catalog.developmentBranch || "dev",
		releaseBranch: entry.releaseBranch || catalog.releaseBranch || "main",
		deployable: entry.type === "plugin" || entry.type === "theme",
		releasable: entry.releasable !== false,
		declaredDependencies: entry.dependencies || [],
		dependencies: [],
		dependents: [],
	}));
	const names = new Map(nodes.map((node) => [node.slug, node]));

	for (const node of nodes) {
		for (const [slug, kind, constraint] of node.declaredDependencies) {
			const dependency = names.get(slug);
			if (!dependency) {
				throw new Error(`${node.slug} references unknown dependency ${slug}`);
			}
			if (!["composer", "npm", "build"].includes(kind)) {
				throw new Error(`${node.slug} has unknown dependency kind ${kind}`);
			}
			addEdge(node, dependency, kind, constraint);
		}
	}

	assertAcyclic(nodes);
	return {
		nodes,
	};
}

export function assertAcyclic(nodes) {
	const visiting = new Set();
	const visited = new Set();
	const visit = (node, trail = []) => {
		if (visiting.has(node.slug)) {
			throw new Error(`Dependency cycle: ${[...trail, node.slug].join(" -> ")}`);
		}
		if (visited.has(node.slug)) return;
		visiting.add(node.slug);
		for (const edge of node.dependencies) visit(edge.node, [...trail, node.slug]);
		visiting.delete(node.slug);
		visited.add(node.slug);
	};
	for (const node of nodes) visit(node);
}

function dependencyCanUse(edge, dependencyVersion) {
	if (edge.kind === "build") return true;
	return constraintAllows(edge.constraint, dependencyVersion);
}

function orderedSelection(nodes, selected) {
	const output = [];
	const visited = new Set();
	const visit = (node) => {
		if (visited.has(node.slug)) return;
		visited.add(node.slug);
		for (const edge of node.dependencies) visit(edge.node);
		if (selected.has(node.slug)) output.push(selected.get(node.slug));
	};
	for (const node of nodes) visit(node);
	return output;
}

export function buildPlan({
	nodes,
	states,
	targetSlug = null,
	targetSlugs = null,
	targetVersion = null,
	force = false,
}) {
	const requestedSlugs = (targetSlugs || [targetSlug])
		.filter(Boolean)
		.map((slug) => slug.replace(/^builtnorth\//, ""));
	if (!requestedSlugs.length) throw new Error("At least one release target is required");
	if (targetVersion && requestedSlugs.length !== 1) {
		throw new Error("--version can only be used with one release target");
	}

	const requested = requestedSlugs.map((slug) => {
		const node = nodes.find((candidate) => candidate.slug === slug);
		if (!node) throw new Error(`Unknown release target: ${slug}`);
		return node;
	});
	const requestedSet = new Set(requested.map((node) => node.slug));

	const selected = new Map();
	const blockers = [];
	const stateFor = (node) => states[node.slug] || {};
	const select = (node, reason, version = null) => {
		const state = stateFor(node);
		const resolvedVersion =
			version ||
			state.nextVersion ||
			bumpVersion(state.latestVersion || "0.0.0", state.bump || "patch");
		if (!selected.has(node.slug)) {
			selected.set(node.slug, { node, reason, version: resolvedVersion });
			if (node.releasable === false) {
				blockers.push(`${node.slug} is cataloged but has no release workflow`);
			}
		}
		return selected.get(node.slug);
	};

	for (const node of requested) {
		const state = stateFor(node);
		if (state.changed || force || targetVersion) {
			select(
				node,
				"explicit target",
				targetVersion && requested.length === 1 ? targetVersion : null,
			);
		}
	}

	for (const entry of selected.values()) {
		for (const edge of entry.node.dependencies) {
			const dependencyEntry = selected.get(edge.node.slug);
			const dependencyState = stateFor(edge.node);
			const dependencyVersion =
				dependencyEntry?.version || dependencyState.latestVersion;

			if (edge.kind !== "build" && !dependencyVersion) {
				blockers.push(
					`${entry.node.slug} requires ${edge.node.slug} ${edge.constraint}, but no released version is available`,
				);
				continue;
			}

			if (!dependencyCanUse(edge, dependencyVersion)) {
				blockers.push(
					`${entry.node.slug} requires ${edge.node.slug} ${edge.constraint}, which excludes ${dependencyEntry ? "planned" : "released"} ${dependencyVersion}`,
				);
			}

			if (
				edge.kind === "build" &&
				dependencyEntry &&
				stateFor(edge.node).buildChanged &&
				!stateFor(entry.node).changed
			) {
				blockers.push(
					`${entry.node.slug} imports ${edge.node.slug}; rebuild and commit its production assets before release`,
				);
			}
		}

		for (const reverseEdge of entry.node.dependents) {
			if (
				reverseEdge.kind !== "build" &&
				!dependencyCanUse(reverseEdge, entry.version)
			) {
				blockers.push(
					`${reverseEdge.node.slug} requires ${entry.node.slug} ${reverseEdge.constraint}, which excludes planned ${entry.version}`,
				);
			}
		}
	}

	return {
		target: requested[0],
		requested: requestedSet,
		blockers: [...new Set(blockers)],
		releases: orderedSelection(nodes, selected),
	};
}

function refExists(cwd, ref) {
	try {
		git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
		return true;
	} catch {
		return false;
	}
}

export function readRepositoryState(node) {
	const ref = refExists(node.absolutePath, `origin/${node.developmentBranch}`)
		? `origin/${node.developmentBranch}`
		: refExists(node.absolutePath, node.developmentBranch)
			? node.developmentBranch
			: "HEAD";
	const tags = git(node.absolutePath, [
		"tag",
		"--list",
		"v[0-9]*.[0-9]*.[0-9]*",
		"--sort=-version:refname",
	]);
	const latestTag = tags.split("\n").find(Boolean) || null;
	const range = latestTag ? `${latestTag}..${ref}` : ref;
	const messages = git(node.absolutePath, ["log", "--format=%s%n%b", range])
		.split("\n")
		.filter(Boolean);
	const changedFiles = git(
		node.absolutePath,
		latestTag
			? ["diff", "--name-only", range]
			: ["ls-tree", "-r", "--name-only", ref],
	)
		.split("\n")
		.filter(Boolean);
	const bump = classifyCommits(messages);
	const latestVersion = latestTag?.replace(/^v/, "") || "0.0.0";
	return {
		changed: messages.length > 0,
		latestTag,
		latestVersion,
		bump,
		nextVersion: bumpVersion(latestVersion, bump),
		buildChanged: changedFiles.some(
			(file) =>
				file === "package.json" ||
				file === "package-lock.json" ||
				/^(?:src|assets)\/.*\.(?:js|jsx|ts|tsx|scss|css)$/.test(file),
		),
	};
}

function parseFlags(args) {
	const flags = {
		targets: [],
		catalog: DEFAULT_CATALOG,
		workspace: path.resolve(
			process.env.RUNNER_TEMP || process.cwd(),
			"release-repositories",
		),
		version: null,
		force: false,
		execute: false,
	};
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index];
		if (value === "--target" || value === "--targets") {
			flags.targets = args[++index]
				.split(",")
				.map((slug) => slug.trim())
				.filter(Boolean);
		}
		else if (value === "--catalog") flags.catalog = path.resolve(args[++index]);
		else if (value === "--workspace") flags.workspace = path.resolve(args[++index]);
		else if (value === "--version") flags.version = args[++index].replace(/^v/, "");
		else if (value === "--force") flags.force = true;
		else if (value === "--execute") flags.execute = true;
		else throw new Error(`Unknown option: ${value}`);
	}
	if (!flags.targets.length) throw new Error("--targets is required");
	if (flags.version && flags.targets.length !== 1) {
		throw new Error("--version can only be used with one release target");
	}
	if (
		flags.version &&
		!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(flags.version)
	) {
		throw new Error(`Invalid release version: ${flags.version}`);
	}
	return flags;
}

function printPlan(plan) {
	if (!plan.releases.length) {
		console.log("No release needed.");
		return;
	}
	console.log("Release order:");
	for (const [index, entry] of plan.releases.entries()) {
		console.log(
			`${index + 1}. ${entry.node.slug} v${entry.version} — ${entry.reason}`,
		);
	}
	if (plan.blockers.length) {
		console.log("\nBlocked:");
		for (const blocker of plan.blockers) console.log(`- ${blocker}`);
	}

	if (process.env.GITHUB_STEP_SUMMARY) {
		const lines = ["## Release plan", ""];
		for (const [index, entry] of plan.releases.entries()) {
			lines.push(
				`${index + 1}. \`${entry.node.slug}\` → \`v${entry.version}\` — ${entry.reason}`,
			);
		}
		if (!plan.releases.length) lines.push("No release needed.");
		if (plan.blockers.length) {
			lines.push("", "### Blocked", "");
			for (const blocker of plan.blockers) lines.push(`- ${blocker}`);
		}
		fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
	}
}

function remoteTagCommit(node, tag) {
	const output = git(node.absolutePath, [
		"ls-remote",
		"--tags",
		"origin",
		`refs/tags/${tag}`,
		`refs/tags/${tag}^{}`,
	]);
	const lines = output.split("\n").filter(Boolean);
	const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
	return (peeled || lines[0] || "").split(/\s+/)[0] || null;
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTag(node, tag) {
	const started = Date.now();
	while (Date.now() - started < TAG_TIMEOUT_MS) {
		const commit = remoteTagCommit(node, tag);
		if (commit) {
			return;
		}
		await sleep(TAG_INTERVAL_MS);
	}
	throw new Error(`Timed out waiting for ${node.slug} ${tag}`);
}

function prepareComposerIndex(workspace) {
	const indexPath = path.join(workspace, "_composer-index");
	if (!fs.existsSync(path.join(indexPath, ".git"))) {
		console.log("Cloning builtnorth/composer release index...");
		run("git", [
			"clone",
			"--filter=blob:none",
			"--no-checkout",
			"https://github.com/builtnorth/composer.git",
			indexPath,
		]);
	}
	return indexPath;
}

function composerIndexHasVersion(indexPath, packageName, version) {
	git(indexPath, [
		"fetch",
		"--prune",
		"origin",
		"+refs/heads/main:refs/remotes/origin/main",
	]);
	const repository = JSON.parse(
		git(indexPath, ["show", "origin/main:packages.json"]),
	);
	const records = repository.packages?.[packageName];
	if (!records) return false;

	const candidates = Array.isArray(records)
		? records
		: Object.entries(records).map(([key, record]) => ({ key, ...record }));
	return candidates.some((record) => {
		const candidate = String(
			record.version || record.version_normalized || record.key || "",
		).replace(/^v/, "");
		return candidate === version || candidate === `${version}.0`;
	});
}

async function waitForComposerIndex(indexPath, node, version) {
	const packageName = `builtnorth/${node.slug}`;
	const started = Date.now();
	while (Date.now() - started < TAG_TIMEOUT_MS) {
		if (composerIndexHasVersion(indexPath, packageName, version)) return;
		await sleep(TAG_INTERVAL_MS);
	}
	throw new Error(
		`Timed out waiting for ${packageName} ${version} in the private Composer index`,
	);
}

function assertNotRateLimited(error) {
	const detail = `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`;
	if (/\b(403|429)\b|secondary rate limit|rate limit exceeded/i.test(detail)) {
		throw new Error(`GitHub rate limit response; release stopped without retry.\n${detail}`);
	}
	throw error;
}

async function executePlan(plan) {
	if (plan.blockers.length) throw new Error("Release plan has dependency blockers.");
	if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is required for --execute");
	if (!plan.releases.length) return;
	const composerIndex = prepareComposerIndex(
		path.dirname(plan.releases[0]?.node.absolutePath || process.cwd()),
	);

	for (const entry of plan.releases) {
		const { node, version } = entry;
		const tag = `v${version}`;
		const existing = remoteTagCommit(node, tag);
		if (existing) {
			console.log(`Skipping ${node.slug}: ${tag} already exists.`);
			continue;
		}

		git(node.absolutePath, [
			"fetch",
			"origin",
			node.developmentBranch,
			node.releaseBranch,
			"--tags",
		]);
		git(node.absolutePath, [
			"checkout",
			"-B",
			node.developmentBranch,
			`origin/${node.developmentBranch}`,
		]);
		git(node.absolutePath, [
			"merge",
			"--no-edit",
			`origin/${node.releaseBranch}`,
		]);
		git(node.absolutePath, ["push", "origin", node.developmentBranch]);
		git(node.absolutePath, [
			"checkout",
			"-B",
			node.releaseBranch,
			`origin/${node.releaseBranch}`,
		]);
		git(node.absolutePath, [
			"merge",
			"--ff-only",
			node.developmentBranch,
		]);
		git(node.absolutePath, ["push", "origin", node.releaseBranch]);

		try {
			run("gh", [
				"workflow",
				"run",
				"release.yml",
				"--repo",
				node.repo,
				"--ref",
				node.releaseBranch,
				"-f",
				`version=${version}`,
				"-f",
				"prerelease=false",
			]);
		} catch (error) {
			assertNotRateLimited(error);
		}

		console.log(`Waiting for ${node.slug} ${tag}...`);
		await waitForTag(node, tag);
		if (node.type !== "npm") {
			console.log(`Waiting for builtnorth/${node.slug} ${version} in Composer...`);
			await waitForComposerIndex(composerIndex, node, version);
		}
	}
}

function releaseCandidates(nodes, targetSlugs) {
	const selected = new Set();

	const addDependencies = (node) => {
		if (selected.has(node.slug)) return;
		selected.add(node.slug);
		for (const edge of node.dependencies) addDependencies(edge.node);
	};

	for (const targetSlug of targetSlugs) {
		const slug = targetSlug.replace(/^builtnorth\//, "");
		const target = nodes.find((node) => node.slug === slug);
		if (!target) throw new Error(`Unknown release target: ${targetSlug}`);
		addDependencies(target);
	}

	return nodes.filter((node) => selected.has(node.slug));
}

function prepareRepositories(nodes, workspace) {
	fs.mkdirSync(workspace, { recursive: true });
	for (const node of nodes) {
		node.absolutePath = path.join(workspace, node.slug);
		if (!fs.existsSync(path.join(node.absolutePath, ".git"))) {
			console.log(`Cloning ${node.repo}...`);
			run("git", [
				"clone",
				"--filter=blob:none",
				"--no-checkout",
				`https://github.com/${node.repo}.git`,
				node.absolutePath,
			]);
		}

		const branches = [...new Set([node.developmentBranch, node.releaseBranch])];
		console.log(`Refreshing ${node.slug} branches and tags...`);
		git(node.absolutePath, [
			"fetch",
			"--prune",
			"--tags",
			"origin",
			...branches.map(
				(branch) =>
					`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
			),
		]);
	}
}

async function main() {
	const flags = parseFlags(process.argv.slice(2));
	const graph = loadGraph(flags.catalog);
	const candidates = releaseCandidates(graph.nodes, flags.targets);
	prepareRepositories(candidates, flags.workspace);
	const states = Object.fromEntries(
		candidates.map((node) => [node.slug, readRepositoryState(node)]),
	);
	const plan = buildPlan({
		nodes: graph.nodes,
		states,
		targetSlugs: flags.targets,
		targetVersion: flags.version,
		force: flags.force,
	});
	printPlan(plan);
	if (plan.blockers.length) {
		throw new Error("Release plan has dependency blockers.");
	}
	if (flags.execute) await executePlan(plan);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`ERROR: ${error.message}`);
		process.exitCode = 1;
	});
}
