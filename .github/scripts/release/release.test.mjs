import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
	buildPlan,
	bumpVersion,
	classifyCommits,
	composerPackageName,
	constraintAllows,
	loadGraph,
	readRepositoryState,
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
	assert.equal(graph.nodes.length, 46);
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
			"cryptography",
			"environment-indicator",
			"integrations",
			"job-dispatcher",
			"kitaris-module-ai",
			"kitaris-module-whitelabel",
			"license-manager",
			"package-loader",
			"post-types",
			"rest-access",
			"utility",
			"wp-portability",
		],
	);
	assert.equal(
		graph.nodes.some((node) => "path" in node),
		false,
	);
});

test("plugins that bundle a package released in the run release with it, even through other packages", () => {
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
			"kitaris-seo": { ...state("1.4.9"), shipped: { "builtnorth/wp-utility": "2.4.0" } },
		},
		targetSlug: "wp-utility",
	});

	// The library in between doesn't bundle anything, so it doesn't release.
	assert.deepEqual(
		plan.releases.map((entry) => entry.node.slug),
		["wp-utility", "kitaris-seo"],
	);
	assert.equal(plan.releases[1].version, "1.4.10");
	assert.match(plan.releases[1].reason, /builtnorth\/wp-utility 2\.4\.0 → 2\.4\.1 \(this run\)/);
	assert.deepEqual(plan.blockers, []);
});

test("a requested plugin that shipped an older package than is released releases again", () => {
	const kitaris = packageNode("kitaris");
	const stale = packageNode("kitaris-forms", { deployable: true });
	const current = packageNode("kitaris-seo", { deployable: true });
	connect(stale, kitaris, "^0.1");
	connect(current, kitaris, "^0.1");

	const plan = buildPlan({
		nodes: [kitaris, stale, current],
		states: {
			kitaris: { ...state("0.1.9"), composerName: "kitaris/framework" },
			"kitaris-forms": { ...state("0.6.4"), shipped: { "kitaris/framework": "0.1.8" } },
			"kitaris-seo": { ...state("0.7.3"), shipped: { "kitaris/framework": "0.1.9" } },
		},
		targetSlugs: ["kitaris", "kitaris-forms", "kitaris-seo"],
	});

	assert.deepEqual(
		plan.releases.map((entry) => entry.node.slug),
		["kitaris-forms"],
	);
	assert.equal(plan.releases[0].reason, "dependency update: kitaris/framework 0.1.8 → 0.1.9");
});

test("without a committed lock, a package released after the plugin marks it behind", () => {
	const kitaris = packageNode("kitaris");
	const behind = packageNode("kitaris-performance", { deployable: true });
	const current = packageNode("compass-waas", { deployable: true });
	connect(behind, kitaris, "^0.1");
	connect(current, kitaris, "^0.1");

	const plan = buildPlan({
		nodes: [kitaris, behind, current],
		states: {
			kitaris: { ...state("0.1.9"), releasedAt: 200 },
			"kitaris-performance": { ...state("0.3.3"), shipped: {}, releasedAt: 100 },
			"compass-waas": { ...state("0.1.1"), shipped: {}, releasedAt: 300 },
		},
		targetSlugs: ["kitaris", "kitaris-performance", "compass-waas"],
	});

	assert.deepEqual(
		plan.releases.map((entry) => entry.node.slug),
		["kitaris-performance"],
	);
	assert.match(plan.releases[0].reason, /builtnorth\/kitaris 0\.1\.9 \(released after/);
});

test("a plugin that is behind is left alone when a run doesn't ask for it", () => {
	const kitaris = packageNode("kitaris");
	const plugin = packageNode("kitaris-forms", { deployable: true });
	const other = packageNode("other", { deployable: true });
	connect(plugin, kitaris, "^0.1");

	const plan = buildPlan({
		nodes: [kitaris, plugin, other],
		states: {
			kitaris: state("0.1.9"),
			"kitaris-forms": { ...state("0.6.4"), shipped: { "builtnorth/kitaris": "0.1.8" } },
			other: state("1.0.0", { changed: true }),
		},
		targetSlug: "other",
	});

	assert.deepEqual(
		plan.releases.map((entry) => entry.node.slug),
		["other"],
	);
});

test("a plugin releases after the unreleased packages it bundles", () => {
	const dispatcher = packageNode("job-dispatcher");
	const kitaris = packageNode("kitaris");
	const plugin = packageNode("kitaris-forms", { deployable: true });
	connect(kitaris, dispatcher, "^0.1");
	connect(plugin, kitaris, "^0.1");

	const plan = buildPlan({
		nodes: [dispatcher, kitaris, plugin],
		states: {
			"job-dispatcher": state("0.1.4", { changed: true }),
			kitaris: state("0.1.9"),
			"kitaris-forms": state("0.6.4", { changed: true }),
		},
		targetSlug: "kitaris-forms",
	});

	assert.deepEqual(
		plan.releases.map((entry) => entry.node.slug),
		["job-dispatcher", "kitaris-forms"],
	);
	assert.match(plan.releases[0].reason, /bundled by kitaris-forms/);
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

	// After `make release` prebuilt everything, an unchanged build/ is current, not stale.
	const prebuilt = buildPlan({
		nodes: [charts, plugin],
		states: {
			charts: state("1.3.0", { changed: true, buildChanged: true }),
			"kitaris-seo": state("1.4.9"),
		},
		targetSlugs: ["charts", "kitaris-seo"],
		force: true,
		prebuilt: true,
	});
	assert.deepEqual(prebuilt.blockers, []);
});

test("a release edge orders the dependent after it without constraints or rebuilds", () => {
	const forms = packageNode("kitaris-forms", { deployable: true });
	const directory = packageNode("kitaris-directory", { deployable: true });
	connect(directory, forms, "*", "release");

	const plan = buildPlan({
		nodes: [forms, directory],
		states: {
			"kitaris-forms": state("0.6.3", { changed: true, buildChanged: true }),
			"kitaris-directory": state("0.4.2"),
		},
		targetSlugs: ["kitaris-directory", "kitaris-forms"],
		force: true,
	});

	assert.deepEqual(
		plan.releases.map((entry) => entry.node.slug),
		["kitaris-forms", "kitaris-directory"],
	);
	assert.deepEqual(plan.blockers, []);
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

test("first-party npm packages are found in every dependency list, nothing else", async () => {
	const { firstPartyNpmNames } = await import("./release.mjs");
	assert.deepEqual(
		firstPartyNpmNames({
			dependencies: { "@siratik/ui-kit": "^0.1.0", classnames: "^2.0.0" },
			devDependencies: { "@kitaris/admin": "^0.1.0", "@wordpress/scripts": "^30" },
			peerDependencies: { "@builtnorth/x": "*" },
		}),
		["@siratik/ui-kit", "@kitaris/admin", "@builtnorth/x"],
	);
	assert.deepEqual(firstPartyNpmNames({}), []);
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

test("a package's first release is 0.1.0, then it bumps from its tag", () => {
	const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "first-release-"));
	const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
	try {
		git("init", "-q", "-b", "dev");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "fix: first");
		const node = { absolutePath: dir, developmentBranch: "dev" };
		assert.equal(readRepositoryState(node).nextVersion, "0.1.0");

		git("tag", "v0.1.0");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "fix: second");
		assert.equal(readRepositoryState(node).nextVersion, "0.1.1");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("state reads the Composer name and the versions the last tag shipped", () => {
	const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "shipped-"));
	const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
	try {
		git("init", "-q", "-b", "dev");
		fs.writeFileSync(path.join(dir, "composer.json"), JSON.stringify({ name: "kitaris/forms" }));
		fs.writeFileSync(
			path.join(dir, "composer.lock"),
			JSON.stringify({ packages: [{ name: "kitaris/framework", version: "v0.1.8" }] }),
		);
		git("add", "composer.json", "composer.lock");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fix: first");
		git("tag", "v0.6.4");

		const plugin = readRepositoryState({ absolutePath: dir, developmentBranch: "dev", deployable: true });
		assert.equal(plugin.composerName, "kitaris/forms");
		assert.deepEqual(plugin.shipped, { "kitaris/framework": "0.1.8" });

		const library = readRepositoryState({ absolutePath: dir, developmentBranch: "dev" });
		assert.deepEqual(library.shipped, {});

		// A version stamp alone is not a build change; any other package.json edit is.
		const commit = (file, content) => {
			fs.writeFileSync(path.join(dir, file), content);
			git("add", file);
			git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chore: edit");
		};
		commit("package.json", '{\n\t"name": "x",\n\t"version": "0.6.4"\n}\n');
		git("tag", "v0.6.5");
		commit("package.json", '{\n\t"name": "x",\n\t"version": "0.6.3"\n}\n');
		assert.equal(readRepositoryState({ absolutePath: dir, developmentBranch: "dev" }).buildChanged, false);
		commit("package.json", '{\n\t"name": "y",\n\t"version": "0.6.3"\n}\n');
		assert.equal(readRepositoryState({ absolutePath: dir, developmentBranch: "dev" }).buildChanged, true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// runInDependencyOrder: dependencies first, independent work in parallel.
{
	const { runInDependencyOrder } = await import("./release.mjs");
	const entry = (slug, deps = []) => ({ node: { slug, dependencies: deps.map((d) => ({ node: { slug: d } })) } });
	const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

	test("runInDependencyOrder starts each entry after its dependencies finish", async () => {
		const finished = [];
		const started = {};
		await runInDependencyOrder(
			[entry("a"), entry("b", ["a"]), entry("c", ["a"]), entry("d", ["b", "c"])],
			async ({ node }) => {
				started[node.slug] = [...finished];
				await tick();
				finished.push(node.slug);
			},
			{ concurrency: 4 },
		);
		assert.deepEqual(started.a, []);
		assert.ok(started.b.includes("a") && started.c.includes("a"));
		assert.ok(started.d.includes("b") && started.d.includes("c"));
	});

	test("runInDependencyOrder waits on planned packages it reaches only through others", async () => {
		// forms -> kitaris (not planned) -> job-dispatcher (planned)
		const dispatcher = { slug: "job-dispatcher", dependencies: [] };
		const kitaris = { slug: "kitaris", dependencies: [{ node: dispatcher }] };
		const forms = { slug: "kitaris-forms", dependencies: [{ node: kitaris }] };
		const finished = [];
		const started = {};
		await runInDependencyOrder(
			[{ node: dispatcher }, { node: forms }],
			async ({ node }) => {
				started[node.slug] = [...finished];
				await tick();
				finished.push(node.slug);
			},
			{ concurrency: 4 },
		);
		assert.deepEqual(started["kitaris-forms"], ["job-dispatcher"]);
	});

	test("runInDependencyOrder runs independent entries at once, up to the cap", async () => {
		let active = 0;
		let peak = 0;
		await runInDependencyOrder(
			["a", "b", "c", "d", "e"].map((slug) => entry(slug)),
			async () => {
				active++;
				peak = Math.max(peak, active);
				await tick();
				active--;
			},
			{ concurrency: 3 },
		);
		assert.equal(peak, 3);
	});

	test("runInDependencyOrder skips dependents of a failure and finishes the rest", async () => {
		const ran = [];
		await assert.rejects(
			runInDependencyOrder(
				[entry("a"), entry("b", ["a"]), entry("c")],
				async ({ node }) => {
					ran.push(node.slug);
					if (node.slug === "a") throw new Error("boom");
				},
			),
			/2 release\(s\) did not complete[\s\S]*a: boom[\s\S]*b: skipped/,
		);
		assert.deepEqual(ran.sort(), ["a", "c"]);
	});
}
