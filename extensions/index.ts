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
	selectProfile,
	type GondolinProfileConfig,
	writeStateAtomic,
} from "./config.ts";
import { createGondolinAgent, type GondolinAgentProfile } from "./router.ts";

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
			let reference: string | undefined;
			if (event.reason === "startup" && ctx.hasUI) {
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
			remember(reference);
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
		provisionVm: (vm) => provisionVm(vm, selected?.profile),
		get promptLines(): readonly string[] {
			return selected?.profile?.promptGuidance ?? [];
		},
		get displayName(): string | undefined {
			return selected?.reference;
		},
	};

	createGondolinAgent(dynamicProfile)(pi);
}
