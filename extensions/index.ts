import fs from "node:fs";
import path from "node:path";
import {
	getImageStoreDirectory,
	listImageRefs,
	resolveImageSelector,
	type VM,
	type VMOptions,
} from "@earendil-works/gondolin";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	expandHostSourcePath,
	filterReferences,
	loadConfig,
	parseMode,
	prioritizeRemembered,
	readState,
	referencesForProfile,
	resolveProfileReference,
	selectProfile,
	type GondolinProfileConfig,
	writeStateAtomic,
} from "./config.ts";
import {
	createGondolinAgent,
	type GondolinAgentProfile,
	type GondolinReadonlyMount,
} from "./router.ts";

const CONFIG_FILE = "gondolin-selector.json";
const STATE_FILE = "gondolin-selector-state.json";

interface SelectedProfile {
	reference: string;
	imagePath: string;
	profile?: GondolinProfileConfig;
}

function quoteShell(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function runGuestCommand(vm: VM, command: string): Promise<void> {
	const result = await vm.exec(["/bin/sh", "-lc", command]);
	if (result.exitCode !== 0) throw new Error(`Guest provisioning command failed with exit code ${result.exitCode}`);
}

function resolveReadonlyMounts(profile: GondolinProfileConfig | undefined): GondolinReadonlyMount[] {
	const mounts: GondolinReadonlyMount[] = [];
	for (const mount of profile?.mounts ?? []) {
		const source = expandHostSourcePath(mount.source);
		try {
			fs.accessSync(source, fs.constants.R_OK);
			const canonicalSource = fs.realpathSync(source);
			if (!fs.statSync(canonicalSource).isDirectory()) throw new Error("not a directory");
			mounts.push({ hostPath: canonicalSource, guestPath: mount.destination });
		} catch {
			if (mount.required !== false) throw new Error(`Required mount source is not a readable directory: ${source}`);
		}
	}
	return mounts;
}

function validateHostResources(profile: GondolinProfileConfig | undefined): void {
	for (const file of profile?.files ?? []) {
		if (!file.source) continue;
		const source = expandHostSourcePath(file.source);
		try {
			fs.accessSync(source, fs.constants.R_OK);
		} catch {
			if (file.required !== false) throw new Error(`Required file is not readable: ${source}`);
		}
	}
	resolveReadonlyMounts(profile);
}

function formatProfileOverview(
	profiles: readonly GondolinProfileConfig[],
	references: readonly string[],
	configPath: string,
): string {
	const lines = [`Gondolin profiles (${configPath}):`];
	if (profiles.length === 0) lines.push("  (none configured)");

	for (const profile of profiles) {
		const matches = referencesForProfile(profile, references);
		let selection: string;
		if (matches.length === 0) {
			selection = "unavailable (no matching local image)";
		} else if (matches.length > 1) {
			selection = `choose an image with --gondolin-image (${matches.length} matches)`;
		} else {
			try {
				selectProfile(matches[0]!, profiles);
				selection = "ready";
			} catch (error) {
				selection = `invalid (${error instanceof Error ? error.message : String(error)})`;
			}
		}
		const runtime = [
			`dns=${profile.network?.dns?.mode ?? "default"}`,
			`tcpMappings=${Object.keys(profile.network?.tcpHosts ?? {}).length}`,
			`directories=${profile.directories?.length ?? 0}`,
			`files=${profile.files?.length ?? 0}`,
			`mounts=${profile.mounts?.length ?? 0}`,
		];
		let resources = "ready";
		try {
			validateHostResources(profile);
		} catch (error) {
			resources = error instanceof Error ? error.message : String(error);
		}

		lines.push(
			`\n${profile.name}`,
			`  Image pattern: ${profile.imagePattern}`,
			`  Matching images: ${matches.join(", ") || "(none)"}`,
			`  Selection: ${selection}`,
			`  Runtime: ${runtime.join(", ")}`,
			`  Host resources: ${resources}`,
		);
	}

	const profiledReferences = new Set(profiles.flatMap((profile) => referencesForProfile(profile, references)));
	const genericReferences = references.filter((reference) => !profiledReferences.has(reference));
	if (genericReferences.length > 0) lines.push(`\nUnprofiled images: ${genericReferences.join(", ")}`);
	return lines.join("\n");
}

function displayProfileOverview(ctx: ExtensionContext, overview: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(overview, "info");
	} else if (ctx.mode === "json") {
		process.stderr.write(`${overview}\n`);
	} else {
		process.stdout.write(`${overview}\n`);
	}
}

async function provisionVm(vm: VM, profile: GondolinProfileConfig | undefined): Promise<void> {
	for (const directory of profile?.directories ?? []) {
		const mode = parseMode(directory.mode, `directory ${directory.path} mode`);
		await vm.fs.mkdir(directory.path, { recursive: true });
		await runGuestCommand(vm, `chmod ${mode.toString(8)} -- ${quoteShell(directory.path)}`);
	}

	for (const file of profile?.files ?? []) {
		let content: string;
		if (file.source) {
			const source = expandHostSourcePath(file.source);
			try {
				content = fs.readFileSync(source, "utf8");
			} catch {
				if (file.required === false) continue;
				throw new Error(`Required file is not readable: ${source}`);
			}
		} else {
			content = file.content ?? "";
		}

		await vm.fs.mkdir(path.posix.dirname(file.destination), { recursive: true });
		await vm.fs.writeFile(file.destination, content, { encoding: "utf8" });
		const mode = parseMode(file.mode, `file ${file.destination} mode`);
		await runGuestCommand(vm, `chmod ${mode.toString(8)} -- ${quoteShell(file.destination)}`);
	}
}

export default function gondolinSelector(pi: ExtensionAPI) {
	pi.registerFlag("gondolin-profile", {
		description: "Select a configured Gondolin profile without showing the startup menu",
		type: "string",
	});
	pi.registerFlag("gondolin-image", {
		description: "Select an exact Gondolin image for --gondolin-profile",
		type: "string",
	});
	pi.registerFlag("gondolin-workspace-root", {
		description: "Mount this host directory at /workspace while keeping Pi's CWD as the guest child CWD",
		type: "string",
	});
	pi.registerFlag("list-gondolin-profiles", {
		description: "List configured Gondolin profiles and matching local images",
		type: "boolean",
		default: false,
	});

	const agentDir = getAgentDir();
	const configPath = path.join(agentDir, CONFIG_FILE);
	const statePath = path.join(agentDir, STATE_FILE);
	const config = loadConfig(configPath);
	const projectPath = fs.realpathSync(process.cwd());
	let selected: SelectedProfile | undefined;
	let cancelled = false;

	function discoverReferences(): string[] {
		const references = listImageRefs().map(({ reference }) => reference);
		return filterReferences(references, config.imageFilter);
	}

	function rememberedReference(): string | undefined {
		if (config.rememberByProject === false) return undefined;
		return readState(statePath).projects[projectPath];
	}

	function remember(reference: string): void {
		if (config.rememberByProject === false) return;
		const state = readState(statePath);
		state.projects[projectPath] = reference;
		writeStateAtomic(statePath, state);
	}

	function resolveSelection(reference: string): SelectedProfile {
		const profile = selectProfile(reference, config.profiles ?? []);
		const imagePath = resolveImageSelector(reference).assetDir;
		return { reference, imagePath, profile };
	}

	async function chooseReference(ctx: ExtensionContext, exitOnCancel: boolean): Promise<string | undefined> {
		const references = discoverReferences();
		if (references.length === 0) {
			const filterMessage = config.imageFilter ? ` matching imageFilter ${JSON.stringify(config.imageFilter)}` : "";
			ctx.ui.notify(`No locally tagged Gondolin images${filterMessage} were found in ${getImageStoreDirectory()}.`, "error");
			if (exitOnCancel) ctx.shutdown();
			return undefined;
		}

		const remembered = rememberedReference();
		const choices = prioritizeRemembered(references, remembered);
		const title = remembered && choices.includes(remembered)
			? `Select Gondolin image (last used: ${remembered})`
			: "Select Gondolin image";
		const choice = await ctx.ui.select(title, choices);
		if (!choice) {
			if (exitOnCancel) ctx.shutdown();
			return undefined;
		}
		return choice;
	}

	pi.on("session_start", async (event, ctx) => {
		cancelled = false;
		try {
			const profileFlag = pi.getFlag("gondolin-profile");
			const imageFlag = pi.getFlag("gondolin-image");
			const listProfiles = pi.getFlag("list-gondolin-profiles") === true;
			const explicitProfile = typeof profileFlag === "string" ? profileFlag : undefined;
			const explicitImage = typeof imageFlag === "string" ? imageFlag : undefined;

			if (listProfiles) {
				if (explicitProfile !== undefined || explicitImage !== undefined) {
					throw new Error("--list-gondolin-profiles cannot be combined with --gondolin-profile or --gondolin-image");
				}
				cancelled = true;
				selected = undefined;
				displayProfileOverview(ctx, formatProfileOverview(config.profiles ?? [], discoverReferences(), configPath));
				ctx.shutdown();
				return;
			}
			if (explicitImage !== undefined && explicitProfile === undefined) {
				throw new Error("--gondolin-image requires --gondolin-profile");
			}

			let reference: string | undefined;
			if (explicitProfile !== undefined) {
				reference = resolveProfileReference(
					explicitProfile,
					explicitImage,
					discoverReferences(),
					config.profiles ?? [],
				);
			} else if (event.reason === "startup" && ctx.hasUI) {
				reference = await chooseReference(ctx, true);
			} else {
				const remembered = rememberedReference();
				const references = discoverReferences();
				reference = remembered && references.includes(remembered) ? remembered : undefined;
				if (!reference) {
					ctx.ui.notify(
						"No remembered Gondolin image is available. Start Pi interactively and select an image first.",
						"error",
					);
					ctx.shutdown();
				}
			}

			if (!reference) {
				cancelled = true;
				selected = undefined;
				return;
			}
			selected = resolveSelection(reference);
			if (explicitProfile === undefined) remember(reference);
			pi.events.emit("gondolin-selector:selected", {
				profile: selected.profile?.name ?? null,
				reference: selected.reference,
			});
		} catch (error) {
			cancelled = true;
			selected = undefined;
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			ctx.shutdown();
		}
	});

	pi.registerCommand("gondolin-select", {
		description: "Choose the Gondolin image to use on the next Pi start",
		handler: async (_args, ctx) => {
			try {
				if (config.rememberByProject === false) {
					ctx.ui.notify("Enable rememberByProject to save a selection for the next Pi start.", "warning");
					return;
				}
				const reference = await chooseReference(ctx, false);
				if (!reference) return;
				resolveSelection(reference); // Validate profile matching and image resolution now.
				remember(reference);
				ctx.ui.notify(`Remembered ${reference} for ${projectPath}. Restart Pi to use it.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	const dynamicProfile: GondolinAgentProfile = {
		isEnabled: () => !cancelled && selected !== undefined,
		resolveImagePath: () => {
			if (!selected) throw new Error("No Gondolin image selected");
			return selected.imagePath;
		},
		get vmOptions(): Pick<VMOptions, "dns" | "tcp"> | undefined {
			if (!selected?.profile?.network) return undefined;
			const { dns, tcpHosts } = selected.profile.network;
			return {
				...(dns ? { dns } : {}),
				...(tcpHosts ? { tcp: { hosts: tcpHosts } } : {}),
			};
		},
		validateHostResources: () => validateHostResources(selected?.profile),
		get readonlyMounts(): readonly GondolinReadonlyMount[] {
			return resolveReadonlyMounts(selected?.profile);
		},
		provisionVm: (vm) => provisionVm(vm, selected?.profile),
		get promptLines(): readonly string[] {
			return selected?.profile?.promptGuidance ?? [];
		},
		get displayName(): string | undefined {
			return selected?.reference;
		},
		resolveWorkspaceRoot: () => {
			const value = pi.getFlag("gondolin-workspace-root");
			if (value === undefined) return undefined;
			if (typeof value !== "string" || value.length === 0) {
				throw new Error("--gondolin-workspace-root must be a non-empty host directory path");
			}
			return value;
		},
	};

	createGondolinAgent(dynamicProfile)(pi);
}
