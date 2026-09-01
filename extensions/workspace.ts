import fs from "node:fs";
import path from "node:path";

export const GUEST_WORKSPACE = "/workspace";
export const GUEST_GIT_CONFIG = "/root/.gitconfig";

export interface WorkspaceLayout {
	/** Canonical host directory Pi was launched from. */
	hostProjectCwd: string;
	/** Canonical host directory mounted at /workspace. */
	hostWorkspaceRoot: string;
	guestWorkspaceRoot: typeof GUEST_WORKSPACE;
	/** Guest path corresponding to hostProjectCwd. */
	guestProjectCwd: string;
}

export function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

export function isInsideHostPath(root: string, value: string): boolean {
	const relativePath = path.relative(root, value);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
	);
}

function isInsideGuestWorkspace(value: string): boolean {
	const relativePath = path.posix.relative(GUEST_WORKSPACE, value);
	return relativePath === "" || (!relativePath.startsWith("../") && relativePath !== "..");
}

/**
 * Resolve the host mount root independently from Pi's project CWD and derive
 * the corresponding initial CWD inside the guest.
 */
export function resolveWorkspaceLayout(
	hostProjectCwd: string,
	configuredWorkspaceRoot?: string,
): WorkspaceLayout {
	const canonicalProjectCwd = fs.realpathSync(path.resolve(hostProjectCwd));
	if (!fs.statSync(canonicalProjectCwd).isDirectory()) {
		throw new Error(`Pi working directory is not a directory: ${canonicalProjectCwd}`);
	}

	const requestedRoot = configuredWorkspaceRoot
		? path.resolve(canonicalProjectCwd, configuredWorkspaceRoot)
		: canonicalProjectCwd;
	const canonicalWorkspaceRoot = fs.realpathSync(requestedRoot);
	if (!fs.statSync(canonicalWorkspaceRoot).isDirectory()) {
		throw new Error(`Gondolin workspace root is not a directory: ${canonicalWorkspaceRoot}`);
	}
	if (canonicalWorkspaceRoot === path.parse(canonicalWorkspaceRoot).root) {
		throw new Error(`Refusing to mount the host filesystem root as the Gondolin workspace: ${canonicalWorkspaceRoot}`);
	}
	if (!isInsideHostPath(canonicalWorkspaceRoot, canonicalProjectCwd)) {
		throw new Error(
			`Pi working directory ${canonicalProjectCwd} is outside Gondolin workspace root ${canonicalWorkspaceRoot}`,
		);
	}

	const relativeProjectCwd = path.relative(canonicalWorkspaceRoot, canonicalProjectCwd);
	const guestProjectCwd = relativeProjectCwd
		? path.posix.join(GUEST_WORKSPACE, toPosix(relativeProjectCwd))
		: GUEST_WORKSPACE;

	return {
		hostProjectCwd: canonicalProjectCwd,
		hostWorkspaceRoot: canonicalWorkspaceRoot,
		guestWorkspaceRoot: GUEST_WORKSPACE,
		guestProjectCwd,
	};
}

export function hostPathToGuest(layout: WorkspaceLayout, hostPath: string): string {
	const relativePath = path.relative(layout.hostWorkspaceRoot, hostPath);
	if (!isInsideHostPath(layout.hostWorkspaceRoot, hostPath)) return toPosix(hostPath);
	return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}

/** Resolve a Pi tool path into the guest while preserving host absolute paths under the mounted workspace. */
export function toGuestPath(layout: WorkspaceLayout, inputPath: string): string {
	const trimmedInput = inputPath.trim();
	const trimmed = trimmedInput.startsWith("@") ? trimmedInput.slice(1) : trimmedInput;
	if (!trimmed) return layout.guestProjectCwd;
	if (path.isAbsolute(trimmed)) {
		if (isInsideHostPath(layout.hostWorkspaceRoot, trimmed)) return hostPathToGuest(layout, trimmed);
		return path.posix.resolve("/", toPosix(trimmed));
	}
	return path.posix.resolve(layout.guestProjectCwd, toPosix(trimmed));
}

/**
 * Produce one exact Git safe.directory entry. The path is derived from the
 * validated layout, but this function validates again so it is safe to use at
 * the VM provisioning boundary.
 */
export function createGitSafeDirectoryEntry(guestProjectCwd: string): string {
	const normalized = path.posix.normalize(guestProjectCwd);
	if (!path.posix.isAbsolute(guestProjectCwd) || normalized !== guestProjectCwd || !isInsideGuestWorkspace(normalized)) {
		throw new Error(`Git safe.directory must be a normalized path inside ${GUEST_WORKSPACE}: ${guestProjectCwd}`);
	}
	// A full value of "*" and paths ending in "/*" have wildcard semantics in
	// Git. Reject all asterisks so this entry can only ever identify one path.
	if (guestProjectCwd.includes("*")) {
		throw new Error(`Git safe.directory must not contain wildcard characters: ${guestProjectCwd}`);
	}
	if (/[\x00-\x1f\x7f]/.test(guestProjectCwd)) {
		throw new Error("Git safe.directory must not contain control characters");
	}
	const quotedValue = guestProjectCwd.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
	return `[safe]\n\tdirectory = "${quotedValue}"\n`;
}
