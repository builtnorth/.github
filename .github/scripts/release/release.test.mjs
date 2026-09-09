import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	buildPlan,
	bumpVersion,
	classifyCommits,
	constraintAllows,
	loadGraph,
} from "./release.mjs";

function packageNode(slug, { deployable = false } = {}) {
	return {
		slug,
		composerName: `builtnorth/${slug}`,
		npmName: null,
		deployable,
		dependencies: [],
		dependents: [],
	};
}

function connect(consumer, dependency, constraint = "^1.0", kind = "composer") {
	const edge = { node: dependency, constraint, kind };
	consumer.dependencies.push(edge);
	dependency.dependents.push({ node: consumer, constraint, kind });
}

function state(latestVersion, options = {}) {
	const bump = options.bump || "patch";
	return {
		latestVersion,
		changed: options.changed || false,
		buildChanged: options.buildChanged || false,
		bump,
		nextVersion: bumpVersion(latestVersion, bump),
	};
}

test("Composer-style constraints preserve major compatibility", () => {
	assert.equal(constraintAllows("^2.0", "2.9.1"), true);
	assert.equal(constraintAllows("^2.0", "3.0.0"), false);
	assert.equal(constraintAllows("^0.2", "0.2.9"), true);
	assert.equal(constraintAllows("^0.2", "0.3.0"), false);
	assert.equal(constraintAllows(">=1.2 <2.0", "1.8.0"), true);
	assert.equal(constraintAllows("~1.4", "1.5.0"), false);
	assert.equal(constraintAllows("*", "20.0.0"), true);
});

test("Conventional commits calculate independent bumps", () => {
	assert.equal(classifyCommits(["fix: correct queue claim"]), "patch");
	assert.equal(classifyCommits(["feat: add retry policy"]), "minor");
	assert.equal(classifyCommits(["feat!: replace dispatcher API"]), "major");
});

test("changed dependencies are never released unless explicitly selected", () => {
	const instantActions = packageNode("instant-actions");
	const dispatcher = packageNode("job-dispatcher");
	connect(dispatcher, instantActions, "^2.0");

	const plan = buildPlan({
		nodes: [dispatcher, instantActions],
		states: {
			"instant-actions": state("2.0.0", { changed: true }),
			"job-dispatcher": state("2.0.0", { changed: true }),
		},
		targetSlug: "job-dispatcher",
		includeDependents: false,
	});

	assert.deepEqual(
		plan.releases.map((entry) => entry.node.slug),
		["job-dispatcher"],
	);
});

test("catalog provides the release graph without Basecamp paths", () => {
	const graph = loadGraph();
	const dispatcher = graph.nodes.find((node) => node.slug === "job-dispatcher");
	assert.equal(graph.nodes.length, 33);
	assert.deepEqual(
		dispatcher.dependencies.map((edge) => edge.node.slug),
		["instant-actions"],
	);
	const polaris = graph.nodes.find((node) => node.slug === "polaris");
	assert.deepEqual(
		polaris.dependencies
			.filter((edge) => edge.kind === "composer")
			.map((edge) => edge.node.slug),
		[
			"extended-cpts-extras",
			"polaris-ai",
			"polaris-controls",
			"polaris-integrations-lib",
			"wp-baseline",
			"wp-environment-indicator",
			"wp-portability",
			"wp-utility",
		],
	);
	assert.equal(graph.nodes.some((node) => "path" in node), false);
});

test("dependents are never added implicitly", () => {
	const utility = packageNode("wp-utility");
	const polaris = packageNode("polaris");
	const plugin = packageNode("polaris-seo", { deployable: true });
	connect(polaris, utility, "^2.0");
	connect(plugin, polaris, "^2.0");

	const plan = buildPlan({
		nodes: [plugin, polaris, utility],
		states: {
			"wp-utility": state("2.4.0", { changed: true }),
			polaris: state("2.4.0"),
			"polaris-seo": state("1.4.9"),
		},
		targetSlug: "wp-utility",
	});

	assert.deepEqual(
		plan.releases.map((entry) => entry.node.slug),
		["wp-utility"],
	);
});

test("a Polaris major release requires explicit deployable migrations", () => {
	const polaris = packageNode("polaris");
	const plugin = packageNode("polaris-seo", { deployable: true });
	connect(plugin, polaris, "^2.3");

	const plan = buildPlan({
		nodes: [polaris, plugin],
		states: {
			polaris: state("2.4.0", { changed: true, bump: "major" }),
			"polaris-seo": state("1.4.9"),
		},
		targetSlug: "polaris",
	});

	assert.deepEqual(
		plan.releases.map((entry) => entry.node.slug),
		["polaris"],
	);
	assert.match(plan.blockers[0], /excludes planned 3.0.0/);
});

test("build-time consumers require committed rebuilt assets", () => {
	const charts = packageNode("charts");
	const plugin = packageNode("polaris-seo", { deployable: true });
	connect(plugin, charts, "*", "build");

	const plan = buildPlan({
		nodes: [charts, plugin],
		states: {
		charts: state("1.3.0", { changed: true, buildChanged: true }),
			"polaris-seo": state("1.4.9"),
		},
		targetSlugs: ["charts", "polaris-seo"],
		force: true,
	});

	assert.deepEqual(
		plan.releases.map((entry) => entry.node.slug),
		["charts", "polaris-seo"],
	);
	assert.match(plan.blockers[0], /rebuild and commit/);
});

test("orchestrator does not contain Actions run polling commands", () => {
	const script = fs.readFileSync(
		path.join(path.dirname(fileURLToPath(import.meta.url)), "release.mjs"),
		"utf8",
	);
	// gh run watch/list are banned (high API cost, no error surfacing).
	// /actions/runs is allowed — we use it for targeted run-status polling
	// (one call per 90 s per package) to detect failures early. /actions/jobs is banned.
	const banned = [
		["gh", "run", "watch"].join(" "),
		["gh", "run", "list"].join(" "),
		["/actions", "/jobs"].join(""),
	];
	for (const value of banned) assert.equal(script.includes(value), false, value);
});
