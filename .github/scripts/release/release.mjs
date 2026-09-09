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

function readJsonIfPresent(file) {
	return fs.existsSync(file) ? readJson(file) : null;
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

function internalNpmVersion(specifier) {
	const match = String(specifier).match(
		/github\.com\/builtnorth\/[^/]+\/releases\/download\/v(\d+\.\d+\.\d+)\//,
	);
	return match ? match[1] : specifier;
}

function addEdge(node, dependency, kind, constraint) {
	if (node.dependencies.some((edge) => edge.node === dependency && edge.kind === kind)) {
		return;
	}
	node.dependencies.push({ node: dependency, kind, constraint });
	dependency.dependents.push({ node, kind, constraint });
}

function collectSourceFiles(directory, output = []) {
	if (!fs.existsSync(directory)) return output;
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (["build", "node_modules", "vendor", ".git"].includes(entry.name)) continue;
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) collectSourceFiles(file, output);
		else if (/\.(?:js|jsx|ts|tsx|scss)$/.test(entry.name)) output.push(file);
	}
	return output;
}

function importedInternalPackages(node) {
	const found = new Set();
	const pattern =
		/(?:from\s*|import\s*\(|import\s*|require\(|@use\s*|@import\s*)["'](@(?:builtnorth|polaris)\/[^/"']+)/g;
	for (const file of collectSourceFiles(path.join(node.absolutePath, "src"))) {
		const content = fs.readFileSync(file, "utf8");
		for (const match of content.matchAll(pattern)) found.add(match[1]);
	}
	return found;
}

export function loadGraph(root, catalogFile = DEFAULT_CATALOG) {
	const catalog = readJson(catalogFile);
	const nodes = catalog.packages.map((entry) => {
		const absolutePath = path.resolve(root, entry.path);
		const composer = readJsonIfPresent(path.join(absolutePath, "composer.json"));
		const npm = readJsonIfPresent(path.join(absolutePath, "package.json"));
		const slug = entry.repo || path.basename(entry.path);
		const composerType = composer?.type || "";
		return {
			...entry,
			slug,
			repo: `builtnorth/${slug}`,
			absolutePath,
			composer,
			npm,
			composerName: composer?.name || null,
			npmName: npm?.name || null,
			deployable:
				composerType === "wordpress-plugin" || composerType === "wordpress-theme",
			dependencies: [],
			dependents: [],
		};
	});

	const names = new Map();
	for (const node of nodes) {
		if (node.composerName) names.set(node.composerName, node);
		if (node.npmName) names.set(node.npmName, node);
	}

	for (const node of nodes) {
		for (const [name, constraint] of Object.entries(node.composer?.require || {})) {
			const dependency = names.get(name);
			if (dependency) addEdge(node, dependency, "composer", constraint);
		}
		for (const [name, specifier] of Object.entries(node.npm?.dependencies || {})) {
			const dependency = names.get(name);
			if (dependency) {
				addEdge(node, dependency, "npm", internalNpmVersion(specifier));
			}
		}
		for (const name of importedInternalPackages(node)) {
			const dependency = names.get(name);
			if (dependency && dependency !== node) {
				addEdge(node, dependency, "npm-build", "*");
			}
		}
	}

	assertAcyclic(nodes);
	return {
		nodes,
		developmentBranch: catalog.developmentBranch || "dev",
		releaseBranch: catalog.releaseBranch || "main",
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

function versionFor(state, selectedEntry) {
	return selectedEntry?.version || state.latestVersion || "0.0.0";
}

function dependencyCanUse(edge, dependencyVersion) {
	if (edge.kind === "npm" && /^https?:/.test(String(edge.constraint))) {
		return internalNpmVersion(edge.constraint) === dependencyVersion;
	}
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
	targetSlug,
	targetVersion = null,
	includeDependents = true,
	force = false,
}) {
	const target = nodes.find(
		(node) =>
			node.slug === targetSlug ||
			node.composerName === targetSlug ||
			node.npmName === targetSlug,
	);
	if (!target) throw new Error(`Unknown release target: ${targetSlug}`);

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
		}
		return selected.get(node.slug);
	};

	const addChangedDependencies = (consumer, trail = []) => {
		for (const edge of consumer.dependencies) {
			const dependency = edge.node;
			const state = stateFor(dependency);
			if (!state.changed) continue;
			if (trail.includes(dependency.slug)) continue;
			addChangedDependencies(dependency, [...trail, consumer.slug]);
			const entry = select(dependency, `changed dependency of ${consumer.slug}`);
			if (!dependencyCanUse(edge, entry.version)) {
				blockers.push(
					`${consumer.slug} requires ${dependency.slug} ${edge.constraint}, which excludes planned ${entry.version}`,
				);
			}
		}
	};

	addChangedDependencies(target);
	const targetState = stateFor(target);
	if (targetState.changed || force || targetVersion) {
		select(target, "requested target", targetVersion);
	}

	const selectedTarget = selected.get(target.slug);
	if (selectedTarget && target.slug === "polaris") {
		for (const reverseEdge of target.dependents) {
			if (
				reverseEdge.node.deployable &&
				!dependencyCanUse(reverseEdge, selectedTarget.version)
			) {
				blockers.push(
					`${reverseEdge.node.slug} requires polaris ${reverseEdge.constraint}, which excludes planned ${selectedTarget.version}`,
				);
			}
		}
	}

	if (includeDependents) {
		const queue = [...selected.values()];
		const traversed = new Set();
		while (queue.length) {
			const released = queue.shift();
			const key = `${released.node.slug}@${released.version}`;
			if (traversed.has(key)) continue;
			traversed.add(key);

			for (const reverseEdge of released.node.dependents) {
				const consumer = reverseEdge.node;
				if (!dependencyCanUse(reverseEdge, released.version)) continue;
				const state = stateFor(consumer);

				if (reverseEdge.kind === "npm-build" && consumer.deployable && !state.changed) {
					blockers.push(
						`${consumer.slug} imports ${released.node.slug}; rebuild and commit its production assets before release`,
					);
					continue;
				}

				if (consumer.deployable || state.changed) {
					const entry = select(
						consumer,
						consumer.deployable
							? `bundles ${released.node.slug}`
							: `changed dependent of ${released.node.slug}`,
					);
					queue.push(entry);
				} else {
					queue.push({
						node: consumer,
						version: versionFor(state, selected.get(consumer.slug)),
					});
				}
			}
		}
	}

	return {
		target,
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

export function readRepositoryState(node, developmentBranch = "dev") {
	const ref = refExists(node.absolutePath, `origin/${developmentBranch}`)
		? `origin/${developmentBranch}`
		: refExists(node.absolutePath, developmentBranch)
			? developmentBranch
			: "HEAD";
	const tags = git(node.absolutePath, [
		"tag",
		"--merged",
		ref,
		"--list",
		"v[0-9]*.[0-9]*.[0-9]*",
		"--sort=-version:refname",
	]);
	const latestTag = tags.split("\n").find(Boolean) || null;
	const range = latestTag ? `${latestTag}..${ref}` : ref;
	const messages = git(node.absolutePath, ["log", "--format=%s%n%b", range])
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
	};
}

function parseFlags(args) {
	const flags = {
		target: "",
		root: process.cwd(),
		catalog: DEFAULT_CATALOG,
		version: null,
		includeDependents: true,
		force: false,
		execute: false,
		refresh: false,
	};
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index];
		if (value === "--target") flags.target = args[++index];
		else if (value === "--root") flags.root = path.resolve(args[++index]);
		else if (value === "--catalog") flags.catalog = path.resolve(args[++index]);
		else if (value === "--version") flags.version = args[++index].replace(/^v/, "");
		else if (value === "--no-dependents") flags.includeDependents = false;
		else if (value === "--force") flags.force = true;
		else if (value === "--execute") flags.execute = true;
		else if (value === "--refresh") flags.refresh = true;
		else throw new Error(`Unknown option: ${value}`);
	}
	if (!flags.target) throw new Error("--target is required");
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

function assertNotRateLimited(error) {
	const detail = `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`;
	if (/\b(403|429)\b|secondary rate limit|rate limit exceeded/i.test(detail)) {
		throw new Error(`GitHub rate limit response; release stopped without retry.\n${detail}`);
	}
	throw error;
}

async function executePlan(plan, branches) {
	if (plan.blockers.length) throw new Error("Release plan has dependency blockers.");
	if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is required for --execute");

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
			branches.developmentBranch,
			branches.releaseBranch,
			"--tags",
		]);
		git(node.absolutePath, [
			"checkout",
			"-B",
			branches.developmentBranch,
			`origin/${branches.developmentBranch}`,
		]);
		git(node.absolutePath, [
			"merge",
			"--no-edit",
			`origin/${branches.releaseBranch}`,
		]);
		git(node.absolutePath, ["push", "origin", branches.developmentBranch]);
		git(node.absolutePath, [
			"checkout",
			"-B",
			branches.releaseBranch,
			`origin/${branches.releaseBranch}`,
		]);
		git(node.absolutePath, [
			"merge",
			"--ff-only",
			branches.developmentBranch,
		]);
		git(node.absolutePath, ["push", "origin", branches.releaseBranch]);

		try {
			run("gh", [
				"workflow",
				"run",
				"release.yml",
				"--repo",
				node.repo,
				"--ref",
				branches.releaseBranch,
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
	}
}

function refreshRepositories(graph) {
	for (const node of graph.nodes) {
		console.log(`Refreshing ${node.slug} branches and tags...`);
		git(node.absolutePath, [
			"fetch",
			"--prune",
			"--tags",
			"origin",
			`+refs/heads/${graph.developmentBranch}:refs/remotes/origin/${graph.developmentBranch}`,
			`+refs/heads/${graph.releaseBranch}:refs/remotes/origin/${graph.releaseBranch}`,
		]);
	}
}

async function main() {
	const flags = parseFlags(process.argv.slice(2));
	const graph = loadGraph(flags.root, flags.catalog);
	if (flags.refresh) refreshRepositories(graph);
	const states = Object.fromEntries(
		graph.nodes.map((node) => [
			node.slug,
			readRepositoryState(node, graph.developmentBranch),
		]),
	);
	const plan = buildPlan({
		nodes: graph.nodes,
		states,
		targetSlug: flags.target,
		targetVersion: flags.version,
		includeDependents: flags.includeDependents,
		force: flags.force,
	});
	printPlan(plan);
	if (plan.blockers.length) {
		throw new Error("Release plan has dependency blockers.");
	}
	if (flags.execute) await executePlan(plan, graph);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`ERROR: ${error.message}`);
		process.exitCode = 1;
	});
}
