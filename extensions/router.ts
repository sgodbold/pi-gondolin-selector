/**
 * Shared Gondolin-backed Pi extension factory.
 *
 * Agent profiles supply image, networking, provisioning, and prompt-specific
 * behavior while this module owns VM lifecycle and built-in tool routing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { ReadonlyProvider, RealFSProvider, VM, type VMOptions } from "@earendil-works/gondolin";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLocalBashOperations,
	createLsTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE = "/workspace";
const GUEST_PI_DOCUMENTATION = "/opt/pi-coding-agent";
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const DEFAULT_GREP_LIMIT = 100;
const HOST_BASH_PREFIX = "host:";

export interface GondolinReadonlyMount {
	hostPath: string;
	guestPath: string;
}

export interface GondolinAgentProfile {
	resolveImagePath(): string;
	vmOptions?: Pick<VMOptions, "dns" | "tcp">;
	validateHostResources?(): void | Promise<void>;
	readonlyMounts?: readonly GondolinReadonlyMount[];
	provisionVm?(vm: VM): void | Promise<void>;
	promptLines?: readonly string[];
	displayName?: string;
	/** False when startup selection was cancelled or failed. */
	isEnabled?(): boolean;
}

function guestPathsOverlap(left: string, right: string): boolean {
	const isSameOrInside = (root: string, candidate: string) => {
		const relative = path.posix.relative(root, candidate);
		return relative === "" || (!relative.startsWith("../") && relative !== "..");
	};
	return isSameOrInside(left, right) || isSameOrInside(right, left);
}

function normalizeReadonlyMounts(mounts: readonly GondolinReadonlyMount[]): GondolinReadonlyMount[] {
	const result: GondolinReadonlyMount[] = [];
	const reservedGuestPaths = [GUEST_WORKSPACE, GUEST_PI_DOCUMENTATION];
	for (const mount of mounts) {
		if (!path.posix.isAbsolute(mount.guestPath) || path.posix.normalize(mount.guestPath) !== mount.guestPath) {
			throw new Error(`Read-only mount destination must be a normalized absolute guest path: ${mount.guestPath}`);
		}
		const conflict = [...reservedGuestPaths, ...result.map(({ guestPath }) => guestPath)].find((guestPath) =>
			guestPathsOverlap(guestPath, mount.guestPath),
		);
		if (conflict) throw new Error(`Read-only mount destination ${mount.guestPath} overlaps guest mount ${conflict}`);

		const hostPath = fs.realpathSync(mount.hostPath);
		fs.accessSync(hostPath, fs.constants.R_OK);
		if (!fs.statSync(hostPath).isDirectory()) throw new Error(`Read-only mount source is not a directory: ${hostPath}`);
		result.push({ hostPath, guestPath: mount.guestPath });
	}
	return result;
}

function validatePiPackageRoot(candidate: string): string {
	const root = fs.realpathSync(path.resolve(candidate));
	const requiredPaths = ["README.md", "docs", "examples"];
	for (const requiredPath of requiredPaths) {
		fs.accessSync(path.join(root, requiredPath), fs.constants.R_OK);
	}
	return root;
}

function findPiPackageRoot(candidate: string): string | undefined {
	let current: string;
	try {
		const resolved = fs.realpathSync(candidate);
		current = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
	} catch {
		return undefined;
	}

	while (true) {
		try {
			const packageJson = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")) as { name?: string };
			if (packageJson.name === PI_PACKAGE_NAME) return validatePiPackageRoot(current);
		} catch {
			// Keep walking: most parent directories are not package roots.
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function resolvePiPackageRoot(): string {
	const configuredPath = process.env.GONDOLIN_PI_PACKAGE_ROOT?.trim();
	if (configuredPath) {
		try {
			return validatePiPackageRoot(configuredPath);
		} catch (error) {
			throw new Error(`GONDOLIN_PI_PACKAGE_ROOT is not a readable Pi package root: ${configuredPath}`, {
				cause: error,
			});
		}
	}

	const candidates = [
		process.argv[1],
		path.join(os.homedir(), ".pi", "agent", "node_modules", "@earendil-works", "pi-coding-agent"),
	].filter((candidate): candidate is string => Boolean(candidate));
	try {
		candidates.unshift(createRequire(import.meta.url).resolve(PI_PACKAGE_NAME));
	} catch {
		// The CLI path and standard pi agent install are checked below.
	}

	for (const candidate of candidates) {
		const root = findPiPackageRoot(candidate);
		if (root) return root;
	}
	throw new Error(
		`Could not locate the installed ${PI_PACKAGE_NAME} documentation. Set GONDOLIN_PI_PACKAGE_ROOT to its package root.`,
	);
}

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
	const relativePath = path.relative(root, value);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function hostPathToGuest(localCwd: string, hostPath: string): string {
	const relativePath = path.relative(localCwd, hostPath);
	if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
	return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}

function toGuestPath(localCwd: string, inputPath: string): string {
	const trimmed = stripAtPrefix(inputPath.trim());
	if (!trimmed) return GUEST_WORKSPACE;
	if (path.isAbsolute(trimmed)) {
		if (isInsideHostPath(localCwd, trimmed)) return hostPathToGuest(localCwd, trimmed);
		return path.posix.resolve("/", toPosix(trimmed));
	}
	return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
	return {
		readFile: async (filePath) => vm.fs.readFile(toGuestPath(localCwd, filePath)),
		access: async (filePath) => {
			await vm.fs.access(toGuestPath(localCwd, filePath));
		},
		detectImageMimeType: async (filePath) => {
			const ext = path.posix.extname(toGuestPath(localCwd, filePath)).toLowerCase();
			if (ext === ".png") return "image/png";
			if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
			if (ext === ".gif") return "image/gif";
			if (ext === ".webp") return "image/webp";
			return null;
		},
	};
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			await vm.fs.writeFile(toGuestPath(localCwd, filePath), content, { encoding: "utf8" });
		},
		mkdir: async (dirPath) => {
			await vm.fs.mkdir(toGuestPath(localCwd, dirPath), { recursive: true });
		},
	};
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
	const readOps = createGondolinReadOps(vm, localCwd);
	const writeOps = createGondolinWriteOps(vm, localCwd);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
}

function createGondolinLsOps(vm: VM, localCwd: string): LsOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		stat: async (filePath) => vm.fs.stat(toGuestPath(localCwd, filePath)),
		readdir: async (dirPath) => vm.fs.listDir(toGuestPath(localCwd, dirPath)),
	};
}

async function walkGuestFiles(
	vm: VM,
	root: string,
	visit: (guestPath: string, relativePath: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const stat = await vm.fs.stat(root, { signal });
	if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

	const walkDirectory = async (dir: string, relativeDir: string): Promise<boolean> => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const entries = await vm.fs.listDir(dir, { signal });
		for (const entry of entries) {
			if (entry === ".git" || entry === "node_modules") continue;
			const guestPath = path.posix.join(dir, entry);
			const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
			let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
			try {
				entryStat = await vm.fs.stat(guestPath, { signal });
			} catch {
				continue;
			}
			if (entryStat.isDirectory()) {
				if (!(await walkDirectory(guestPath, relativePath))) return false;
			} else if (!(await visit(guestPath, relativePath))) {
				return false;
			}
		}
		return true;
	};

	return walkDirectory(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalizedPattern = toPosix(pattern);
	if (normalizedPattern.includes("/")) {
		return (
			path.posix.matchesGlob(relativePath, normalizedPattern) ||
			path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
		);
	}
	return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

function createGondolinFindOps(vm: VM, localCwd: string): FindOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern, cwd, options) => {
			const root = toGuestPath(localCwd, cwd);
			const results: string[] = [];
			await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
				if (results.length >= options.limit) return false;
				if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
				return results.length < options.limit;
			});
			return results;
		},
	};
}

function createLineMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
	return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
	outputLines: string[];
	lines: string[];
	relativePath: string;
	lineIndex: number;
	contextLines: number;
}): boolean {
	let linesTruncated = false;
	const start = params.contextLines > 0 ? Math.max(0, params.lineIndex - params.contextLines) : params.lineIndex;
	const end =
		params.contextLines > 0
			? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
			: params.lineIndex;

	for (let index = start; index <= end; index++) {
		const rawLine = params.lines[index] ?? "";
		const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
		if (wasTruncated) linesTruncated = true;
		const separator = index === params.lineIndex ? ":" : "-";
		params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
	}
	return linesTruncated;
}

async function executeGondolinGrep(
	vm: VM,
	localCwd: string,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const root = toGuestPath(localCwd, params.path ?? ".");
	const rootStat = await vm.fs.stat(root, { signal });
	const rootIsDirectory = rootStat.isDirectory();
	const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
	const contextLines = params.context && params.context > 0 ? params.context : 0;
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const outputLines: string[] = [];
	const details: GrepToolDetails = {};
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;

	await walkGuestFiles(
		vm,
		root,
		async (guestPath, relativePath) => {
			if (matchCount >= effectiveLimit) return false;
			if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
			let content: string;
			try {
				content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
			} catch {
				return true;
			}
			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
			for (let index = 0; index < lines.length; index++) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (!matcher(lines[index] ?? "")) continue;
				matchCount++;
				if (appendGrepBlock({ outputLines, lines, relativePath: displayPath, lineIndex: index, contextLines })) {
					linesTruncated = true;
				}
				if (matchCount >= effectiveLimit) {
					matchLimitReached = true;
					return false;
				}
			}
			return true;
		},
		signal,
	);

	if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const rawOutput = outputLines.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	let output = truncation.content;

	if (matchLimitReached) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

// Host env vars that are meaningful and safe inside the guest. Everything else
// (API tokens, SSH_AUTH_SOCK, DBUS/Wayland/Hyprland/tmux session state, ...) is
// dropped so host secrets and desktop session plumbing never reach the VM.
const GUEST_ENV_KEEP_EXACT = new Set([
	"TERM",
	"COLORTERM",
	"LANG",
	"LC_ALL",
	"LC_COLLATE",
	"TZ",
	"EDITOR",
	"VISUAL",
	"PAGER",
]);
const GUEST_ENV_KEEP_PREFIXES = ["PI_", "RTK_", "GIT_"];

function buildGuestEnv(source: NodeJS.ProcessEnv | undefined, shellPath: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(source ?? {})) {
		if (typeof value !== "string") continue;
		if (GUEST_ENV_KEEP_EXACT.has(key) || GUEST_ENV_KEEP_PREFIXES.some((prefix) => key.startsWith(prefix))) {
			result[key] = value;
		}
	}
	// Guest-canonical identity and paths. The guest runs as root; pinning these
	// keeps agent and interactive (`!`) shells identical regardless of what the
	// host passed, and keeps per-user state (rtk, caches) in one place.
	result.HOME = "/root";
	result.USER = "root";
	result.LOGNAME = "root";
	result.SHELL = shellPath;
	result.TMPDIR = "/tmp";
	result.PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
	result.XDG_CACHE_HOME = "/tmp/.cache";
	result.XDG_CONFIG_HOME = "/tmp/.config";
	result.XDG_DATA_HOME = "/tmp/.local/share";
	return result;
}

function createGondolinBashOps(vm: VM, localCwd: string, shellPath: string): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("aborted");
			const guestCwd = toGuestPath(localCwd, cwd);
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			const timer =
				timeout && timeout > 0
					? setTimeout(() => {
							timedOut = true;
							controller.abort();
						}, timeout * 1000)
					: undefined;

			try {
				const proc = vm.exec([shellPath, "-lc", command], {
					cwd: guestCwd,
					// pi's agent bash tool passes the host process env, but its
					// user_bash path (interactive `!` commands) passes no env at all.
					// Scrub and pin both paths to the same guest-canonical env so host
					// state never leaks in and per-user tools (e.g. rtk's history.db)
					// stay consistent between agent and interactive shells.
					env: buildGuestEnv(env ?? process.env, shellPath),
					signal: controller.signal,
					stdout: "pipe",
					stderr: "pipe",
				});
				for await (const chunk of proc.output()) onData(chunk.data);
				const result = await proc;
				return { exitCode: result.exitCode };
			} catch (error) {
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

function registerGondolinAgent(pi: ExtensionAPI, profile: GondolinAgentProfile) {
	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localUserBashOperations = createLocalBashOperations();
	const localGrep = createGrepTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localLs = createLsTool(localCwd);
	const piPackageRoot = resolvePiPackageRoot();

	let vm: VM | undefined;
	let vmStarting: Promise<VM> | undefined;
	let shellPath = "/bin/sh";
	let activeReadonlyMounts: GondolinReadonlyMount[] = [];

	async function startVm(ctx?: ExtensionContext): Promise<VM> {
		if (profile.isEnabled && !profile.isEnabled()) throw new Error("No Gondolin image selected");
		const displayName = profile.displayName ?? GUEST_WORKSPACE;
		ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", `Gondolin: starting ${displayName}`));
		let created: VM | undefined;

		try {
			await profile.validateHostResources?.();
			const readonlyMounts = normalizeReadonlyMounts(profile.readonlyMounts ?? []);
			const vfsMounts = {
				[GUEST_WORKSPACE]: new RealFSProvider(localCwd),
				[GUEST_PI_DOCUMENTATION]: new ReadonlyProvider(new RealFSProvider(piPackageRoot)),
			} as Record<string, RealFSProvider | ReadonlyProvider>;
			for (const mount of readonlyMounts) {
				vfsMounts[mount.guestPath] = new ReadonlyProvider(new RealFSProvider(mount.hostPath));
			}
			created = await VM.create({
				...profile.vmOptions,
				sessionLabel: `pi ${path.basename(localCwd)}`,
				sandbox: {
					imagePath: profile.resolveImagePath(),
				},
				vfs: { mounts: vfsMounts },
			});
			activeReadonlyMounts = readonlyMounts;
			await profile.provisionVm?.(created);
			for (const requiredPath of ["README.md", "docs", "examples"]) {
				await created.fs.access(path.posix.join(GUEST_PI_DOCUMENTATION, requiredPath));
			}
			const bashProbe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
			shellPath = bashProbe.stdout.trim() || "/bin/sh";
			vm = created;
			ctx?.ui.setStatus(
				"gondolin",
				ctx.ui.theme.fg("accent", `Gondolin: ${created.id.slice(0, 8)} (${GUEST_WORKSPACE})`),
			);
			const mountMessage = readonlyMounts.length > 0 ? `; profile mounts: ${readonlyMounts.length} (read-only)` : "";
			ctx?.ui.notify(
				`Gondolin VM ready. Workspace: ${GUEST_WORKSPACE}; Pi documentation: ${GUEST_PI_DOCUMENTATION} (read-only)${mountMessage}.`,
				"info",
			);
			return created;
		} catch (error) {
			activeReadonlyMounts = [];
			let cleanupError: unknown;
			if (created) {
				try {
					await created.close();
				} catch (closeError) {
					cleanupError = closeError;
				}
			}

			const message = error instanceof Error ? error.message : String(error);
			const cleanupMessage = cleanupError
				? ` Cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
				: "";
			ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("error", "Gondolin: startup failed"));
			ctx?.ui.notify(`Gondolin VM failed to start: ${message}${cleanupMessage}`, "error");
			throw error;
		}
	}

	async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
		if (profile.isEnabled && !profile.isEnabled()) throw new Error("No Gondolin image selected");
		if (vm) return vm;
		if (!vmStarting) {
			vmStarting = startVm(ctx).finally(() => {
				vmStarting = undefined;
			});
		}
		return vmStarting;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (profile.isEnabled && !profile.isEnabled()) return;
		try {
			await ensureVm(ctx);
		} catch {
			// startVm already displayed a credential-safe error. Do not leave Pi
			// running with Gondolin tool overrides but no usable VM.
			ctx.shutdown();
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const activeVm = vm;
		vm = undefined;
		vmStarting = undefined;
		activeReadonlyMounts = [];
		if (!activeVm) {
			ctx.ui.setStatus("gondolin", undefined);
			return;
		}
		ctx.ui.setStatus("gondolin", ctx.ui.theme.fg("muted", "Gondolin: stopping"));
		try {
			await activeVm.close();
		} finally {
			ctx.ui.setStatus("gondolin", undefined);
		}
	});

	pi.registerCommand("gondolin", {
		description: "Show Gondolin VM status",
		handler: async (_args, ctx) => {
			const activeVm = await ensureVm(ctx);
			ctx.ui.notify(
				[
					`Gondolin VM: ${activeVm.id}`,
					...(profile.displayName ? [`Image: ${profile.displayName}`] : []),
					`Host workspace: ${localCwd}`,
					`Guest workspace: ${GUEST_WORKSPACE}`,
					`Pi documentation: ${GUEST_PI_DOCUMENTATION} (read-only; host: ${piPackageRoot})`,
					...activeReadonlyMounts.map(
						({ hostPath, guestPath }) => `Profile mount: ${guestPath} (read-only; host: ${hostPath})`,
					),
					`Shell: ${shellPath}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createReadTool(GUEST_WORKSPACE, {
				operations: createGondolinReadOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createWriteTool(GUEST_WORKSPACE, {
				operations: createGondolinWriteOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createEditTool(GUEST_WORKSPACE, {
				operations: createGondolinEditOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createBashTool(GUEST_WORKSPACE, {
				operations: createGondolinBashOps(activeVm, localCwd, shellPath),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createLsTool(GUEST_WORKSPACE, {
				operations: createGondolinLsOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createFindTool(GUEST_WORKSPACE, {
				operations: createGondolinFindOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			return executeGondolinGrep(activeVm, localCwd, params, signal);
		},
	});

	pi.on("user_bash", async (event, ctx) => {
		if (event.command.startsWith(HOST_BASH_PREFIX)) {
			return {
				operations: {
					exec: (_command, cwd, options) =>
						localUserBashOperations.exec(
							event.command.slice(HOST_BASH_PREFIX.length).trimStart(),
							cwd,
							options,
						),
				},
			};
		}

		const activeVm = await ensureVm(ctx);
		return { operations: createGondolinBashOps(activeVm, localCwd, shellPath) };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (profile.isEnabled && !profile.isEnabled()) return;
		await ensureVm(ctx);
		const localLine = `Current working directory: ${localCwd}`;
		const guestLine = `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; host workspace mounted from ${localCwd})`;
		let systemPrompt = event.systemPrompt.includes(localLine)
			? event.systemPrompt.replace(localLine, guestLine)
			: `${event.systemPrompt}\n\n${guestLine}`;
		systemPrompt = systemPrompt.split(piPackageRoot).join(GUEST_PI_DOCUMENTATION);
		const documentationLine = `Pi documentation is mounted read-only at ${GUEST_PI_DOCUMENTATION} (README.md, docs/, and examples/).`;
		if (!systemPrompt.includes(documentationLine)) systemPrompt += `\n${documentationLine}`;
		for (const { hostPath, guestPath } of activeReadonlyMounts) {
			const mountLine = `Host directory ${hostPath} is mounted read-only at ${guestPath}.`;
			if (!systemPrompt.includes(mountLine)) systemPrompt += `\n${mountLine}`;
		}
		for (const promptLine of profile.promptLines ?? []) {
			if (!systemPrompt.includes(promptLine)) systemPrompt += `\n${promptLine}`;
		}
		return { systemPrompt };
	});
}

export function createGondolinAgent(profile: GondolinAgentProfile) {
	return (pi: ExtensionAPI) => registerGondolinAgent(pi, profile);
}
