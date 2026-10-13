import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	buildPlan,
	bumpVersion,
	classifyCommits,
	composerPackageName,
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

test("1.x and later bump normally", () => {
	assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
	assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
	assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
	assert.equal(bumpVersion("2.5.0", "major"), "3.0.0");
});

test("pre-1.0 packages stay pre-1.0", () => {
	// Breaking changes move the minor, which is the breaking-change position
	// below 1.0 -- never the major, which would eject the package from 0.x.
	assert.equal(bumpVersion("0.4.2", "major"), "0.5.0");
	assert.equal(bumpVersion("0.1.0", "major"), "0.2.0");
	// Features and fixes both move the patch, keeping `^0.x` consumers working.
	assert.equal(bumpVersion("0.4.2", "minor"), "0.4.3");
	assert.equal(bumpVersion("0.4.2", "patch"), "0.4.3");
	assert.equal(bumpVersion("0.0.0", "major"), "0.1.0");
});

test("a 0.x bump keeps satisfying its own caret constraint", () => {
	// The practical guarantee: a non-breaking release must not fall outside the
	// constraint consumers have committed.
	assert.equal(constraintAllows("^0.4", bumpVersion("0.4.2", "minor")), true);
	assert.equal(constraintAllows("^0.4", bumpVersion("0.4.2", "patch")), true);
	// ...and a breaking one must, so the mismatch surfaces as a blocker.
	assert.equal(
		constraintAllows("^0.4", bumpVersion("0.4.2", "major")),
		false,
	);
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
	const dispatcher = graph.nodes.find(
		(node) => node.slug === "job-dispatcher",
	);
	assert.equal(graph.nodes.length, 43);
	assert.deepEqual(
		dispatcher.dependencies.map((edge) => edge.node.slug).sort(),
		["instant-actions", "package-loader"],
	);
	const kitaris = graph.nodes.find((node) => node.slug === "kitaris");
	assert.deepEqual(
		kitaris.dependencies
			.filter((edge) => edge.kind === "composer")
			.map((edge) => edge.node.slug)
			.sort(),
		[
			"abilities",
			"access-control",
			"atomic-store",
			"baseline",
			"config",
			"environment-indicator",
			"integrations",
			"job-dispatcher",
			"kitaris-module-ai",
			"kitaris-module-whitelabel",
			"license-manager",
			"package-loader",
			"post-types",
			"rest-access",
			"secret-cipher",
			"utility",
			"wp-portability",
		],
	);
	assert.equal(
		graph.nodes.some((node) => "path" in node),
		false,
	);
});

test("dependents are never added implicitly", () => {
	const utility = packageNode("wp-utility");
	const kitaris = packageNode("kitaris");
	const plugin = packageNode("kitaris-seo", { deployable: true });
	connect(kitaris, utility, "^2.0");
	connect(plugin, kitaris, "^2.0");

	const plan = buildPlan({
		nodes: [plugin, kitaris, utility],
		states: {
			"wp-utility": state("2.4.0", { changed: true }),
			kitaris: state("2.4.0"),
			"kitaris-seo": state("1.4.9"),
		},
		targetSlug: "wp-utility",
	});

	assert.deepEqual(
		plan.releases.map((entry) => entry.node.slug),
		["wp-utility"],
	);
});

test("a Kitaris major release requires explicit deployable migrations", () => {
	const kitaris = packageNode("kitaris");
	const plugin = packageNode("kitaris-seo", { deployable: true });
	connect(plugin, kitaris, "^2.3");

	const plan = buildPlan({
		nodes: [kitaris, plugin],
		states: {
			kitaris: state("2.4.0", { changed: true, bump: "major" }),
			"kitaris-seo": state("1.4.9"),
		},
		targetSlug: "kitaris",
	});

	assert.deepEqual(
		plan.releases.map((entry) => entry.node.slug),
		["kitaris"],
	);
	assert.match(plan.blockers[0], /excludes planned 3.0.0/);
});

test("build-time consumers require committed rebuilt assets", () => {
	const charts = packageNode("charts");
	const plugin = packageNode("kitaris-seo", { deployable: true });
	connect(plugin, charts, "*", "build");

	const plan = buildPlan({
		nodes: [charts, plugin],
		states: {
			charts: state("1.3.0", { changed: true, buildChanged: true }),
			"kitaris-seo": state("1.4.9"),
		},
		targetSlugs: ["charts", "kitaris-seo"],
		force: true,
	});

	assert.deepEqual(
		plan.releases.map((entry) => entry.node.slug),
		["charts", "kitaris-seo"],
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
	for (const value of banned)
		assert.equal(script.includes(value), false, value);
});

test("The Composer index wait uses the package's own Composer name", () => {
	const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "composer-name-"));
	try {
		fs.writeFileSync(path.join(dir, "composer.json"), JSON.stringify({ name: "siratik/utility" }));
		assert.equal(composerPackageName({ slug: "utility", absolutePath: dir }), "siratik/utility");
		assert.equal(composerPackageName({ slug: "utility", absolutePath: dir, composerName: "acme/utility" }), "acme/utility");
		assert.equal(composerPackageName({ slug: "utility", absolutePath: path.join(dir, "missing") }), "builtnorth/utility");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
