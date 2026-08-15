import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	filterReferences,
	parseMode,
	prioritizeRemembered,
	readState,
	selectProfile,
	validateConfig,
	writeStateAtomic,
} from "../extensions/config.ts";

test("imageFilter is a regular expression", () => {
	assert.deepEqual(
		filterReferences(["default-agent:latest", "homelab-agent:dev", "other:latest"], "^(default|homelab)-agent:"),
		["default-agent:latest", "homelab-agent:dev"],
	);
	assert.throws(() => validateConfig({ imageFilter: "[" }), /not a valid regular expression/);
});

test("profile patterns use minimatch and ambiguity is rejected", () => {
	const profiles = [
		{ name: "default", imagePattern: "default-agent:*" },
		{ name: "homelab", imagePattern: "homelab-agent:*" },
	];
	assert.equal(selectProfile("homelab-agent:latest", profiles)?.name, "homelab");
	assert.equal(selectProfile("other:latest", profiles), undefined);
	assert.throws(
		() => selectProfile("homelab-agent:latest", [...profiles, { name: "all", imagePattern: "*-agent:*" }]),
		/matches multiple Gondolin profiles: homelab, all/,
	);
});

test("remembered reference is sorted first", () => {
	assert.deepEqual(prioritizeRemembered(["z:latest", "a:latest", "m:latest"], "m:latest"), [
		"m:latest",
		"a:latest",
		"z:latest",
	]);
});

test("modes are parsed explicitly as octal", () => {
	assert.equal(parseMode("0600", "mode"), 0o600);
	assert.equal(parseMode("700", "mode"), 0o700);
	assert.throws(() => parseMode("999", "mode"), /octal mode/);
});

test("the complete example configuration is valid", () => {
	const examplePath = path.resolve(import.meta.dirname, "../examples/gondolin-selector.json");
	assert.doesNotThrow(() => validateConfig(JSON.parse(fs.readFileSync(examplePath, "utf8"))));
});

test("profile files require exactly one content source", () => {
	assert.throws(
		() =>
			validateConfig({
				profiles: [{ name: "bad", imagePattern: "bad:*", files: [{ destination: "/x", mode: "0600" }] }],
			}),
		/exactly one of source or content/,
	);
});

test("profile mounts require safe, non-overlapping guest destinations", () => {
	assert.doesNotThrow(() =>
		validateConfig({
			profiles: [
				{
					name: "mounted",
					imagePattern: "mounted:*",
					mounts: [{ source: "~/.config/example", destination: "/host/config/example", required: false }],
				},
			],
		}),
	);
	assert.throws(
		() =>
			validateConfig({
				profiles: [
					{
						name: "reserved",
						imagePattern: "reserved:*",
						mounts: [{ source: "/tmp", destination: "/workspace/config" }],
					},
				],
			}),
		/overlaps guest mount \/workspace/,
	);
	assert.throws(
		() =>
			validateConfig({
				profiles: [
					{
						name: "overlap",
						imagePattern: "overlap:*",
						mounts: [
							{ source: "/tmp/one", destination: "/host/config" },
							{ source: "/tmp/two", destination: "/host/config/nested" },
						],
					},
				],
			}),
		/overlaps guest mount \/host\/config/,
	);
	assert.throws(
		() =>
			validateConfig({
				profiles: [
					{
						name: "unnormalized",
						imagePattern: "unnormalized:*",
						mounts: [{ source: "/tmp", destination: "/host/../etc" }],
					},
				],
			}),
		/normalized absolute guest path/,
	);
});

test("state round trips and is owner-only", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-selector-"));
	const statePath = path.join(directory, "state.json");
	try {
		writeStateAtomic(statePath, { projects: { "/project": "default-agent:latest" } });
		assert.deepEqual(readState(statePath), { projects: { "/project": "default-agent:latest" } });
		assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
