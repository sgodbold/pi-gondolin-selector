import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGuestEnv } from "../extensions/router.ts";
import {
	createGitSafeDirectoryEntry,
	resolveWorkspaceLayout,
	toGuestPath,
} from "../extensions/workspace.ts";

function withWorkspace(run: (paths: { root: string; project: string; sibling: string }) => void): void {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-workspace-"));
	const root = path.join(temporaryDirectory, "coordinator");
	const project = path.join(root, "grimoire", ".worktrees", "task-1", "worker");
	const sibling = path.join(root, "grimoire", "coordinator");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(sibling, { recursive: true });
	try {
		run({ root, project, sibling });
	} finally {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

test("workspace layout separates the host mount root from Pi's child CWD", () => {
	withWorkspace(({ root, project }) => {
		const layout = resolveWorkspaceLayout(project, root);
		assert.equal(layout.hostWorkspaceRoot, fs.realpathSync(root));
		assert.equal(layout.hostProjectCwd, fs.realpathSync(project));
		assert.equal(layout.guestWorkspaceRoot, "/workspace");
		assert.equal(layout.guestProjectCwd, "/workspace/grimoire/.worktrees/task-1/worker");
	});
});

test("workspace layout defaults the mount root to Pi's CWD", () => {
	withWorkspace(({ project }) => {
		const layout = resolveWorkspaceLayout(project);
		assert.equal(layout.hostWorkspaceRoot, fs.realpathSync(project));
		assert.equal(layout.guestProjectCwd, "/workspace");
	});
});

test("workspace layout rejects a CWD outside the mounted workspace", () => {
	withWorkspace(({ project, sibling }) => {
		assert.throws(
			() => resolveWorkspaceLayout(project, sibling),
			/outside Gondolin workspace root/,
		);
	});
});

test("tool paths resolve relative to the guest child CWD and map host workspace paths", () => {
	withWorkspace(({ root, project, sibling }) => {
		const layout = resolveWorkspaceLayout(project, root);
		assert.equal(toGuestPath(layout, ""), "/workspace/grimoire/.worktrees/task-1/worker");
		assert.equal(toGuestPath(layout, "src/index.ts"), "/workspace/grimoire/.worktrees/task-1/worker/src/index.ts");
		assert.equal(toGuestPath(layout, "@README.md"), "/workspace/grimoire/.worktrees/task-1/worker/README.md");
		assert.equal(
			toGuestPath(layout, path.join(project, "package.json")),
			"/workspace/grimoire/.worktrees/task-1/worker/package.json",
		);
		assert.equal(toGuestPath(layout, sibling), "/workspace/grimoire/coordinator");
		assert.equal(toGuestPath(layout, "/root/.gitconfig"), "/root/.gitconfig");
	});
});

test("Git safe.directory entry is exact and limited to the workspace mount", () => {
	assert.equal(
		createGitSafeDirectoryEntry("/workspace/grimoire/.worktrees/task-1/worker"),
		'[safe]\n\tdirectory = "/workspace/grimoire/.worktrees/task-1/worker"\n',
	);
	assert.throws(() => createGitSafeDirectoryEntry("/outside/worker"), /inside \/workspace/);
	assert.throws(() => createGitSafeDirectoryEntry("/workspace/tasks/*"), /wildcard/);
	assert.throws(() => createGitSafeDirectoryEntry("/workspace/../outside"), /normalized path/);
});

test("guest environment pins global Git config and removes host config injection", () => {
	const env = buildGuestEnv(
		{
			GIT_AUTHOR_NAME: "Worker",
			GIT_CONFIG: "/host/repository-config",
			GIT_CONFIG_PARAMETERS: "'safe.directory'='*'",
			GIT_CONFIG_GLOBAL: "/host/config",
			GIT_CONFIG_SYSTEM: "/host/system-config",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "safe.directory",
			GIT_CONFIG_VALUE_0: "*",
		},
		"/bin/bash",
	);
	assert.equal(env.GIT_AUTHOR_NAME, "Worker");
	assert.equal(env.GIT_CONFIG, undefined);
	assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
	assert.equal(env.GIT_CONFIG_GLOBAL, "/root/.gitconfig");
	assert.equal(env.GIT_CONFIG_SYSTEM, undefined);
	assert.equal(env.GIT_CONFIG_COUNT, undefined);
	assert.equal(env.GIT_CONFIG_KEY_0, undefined);
	assert.equal(env.GIT_CONFIG_VALUE_0, undefined);
});
