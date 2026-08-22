import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VMOptions } from "@earendil-works/gondolin";
import { minimatch } from "minimatch";

export interface GuestDirectoryConfig {
	path: string;
	mode: string;
}

export interface GuestFileConfig {
	destination: string;
	mode: string;
	required?: boolean;
	source?: string;
	content?: string;
}

export interface HostMountConfig {
	/** Host directory. A leading ~/ is expanded against the host home directory. */
	source: string;
	/** Absolute path where the directory is exposed read-only in the guest. */
	destination: string;
	required?: boolean;
}

export interface GondolinProfileConfig {
	name: string;
	/** A minimatch glob matched against the selected image reference. */
	imagePattern: string;
	network?: {
		dns?: NonNullable<VMOptions["dns"]>;
		/** Gondolin tcp.hosts alias-to-canonical mappings. */
		tcpHosts?: Record<string, string>;
	};
	directories?: GuestDirectoryConfig[];
	files?: GuestFileConfig[];
	mounts?: HostMountConfig[];
	promptGuidance?: string[];
}

export interface SelectorConfig {
	/** Optional JavaScript regular expression applied to tagged image references. */
	imageFilter?: string;
	rememberByProject?: boolean;
	profiles?: GondolinProfileConfig[];
}

export interface SelectorState {
	projects: Record<string, string>;
}

export function expandHostSourcePath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

export function parseMode(value: string, field: string): number {
	if (!/^[0-7]{3,4}$/.test(value)) {
		throw new Error(`${field} must be a three- or four-digit octal mode, got ${JSON.stringify(value)}`);
	}
	return Number.parseInt(value, 8);
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`${field} must be an array of strings`);
	}
}

function guestPathsOverlap(left: string, right: string): boolean {
	const isSameOrInside = (root: string, candidate: string) => {
		const relative = path.posix.relative(root, candidate);
		return relative === "" || (!relative.startsWith("../") && relative !== "..");
	};
	return isSameOrInside(left, right) || isSameOrInside(right, left);
}

export function validateConfig(value: unknown): SelectorConfig {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("configuration must be a JSON object");
	}
	const config = value as SelectorConfig;
	if (config.imageFilter !== undefined) {
		if (typeof config.imageFilter !== "string") throw new Error("imageFilter must be a string");
		try {
			new RegExp(config.imageFilter);
		} catch (error) {
			throw new Error(`imageFilter is not a valid regular expression: ${(error as Error).message}`);
		}
	}
	if (config.rememberByProject !== undefined && typeof config.rememberByProject !== "boolean") {
		throw new Error("rememberByProject must be a boolean");
	}
	if (config.profiles !== undefined && !Array.isArray(config.profiles)) {
		throw new Error("profiles must be an array");
	}
	const profileNames = new Set<string>();
	for (const [profileIndex, profile] of (config.profiles ?? []).entries()) {
		const prefix = `profiles[${profileIndex}]`;
		if (!profile || typeof profile !== "object") throw new Error(`${prefix} must be an object`);
		if (typeof profile.name !== "string" || !profile.name) throw new Error(`${prefix}.name must be a non-empty string`);
		if (profileNames.has(profile.name)) throw new Error(`${prefix}.name duplicates profile ${JSON.stringify(profile.name)}`);
		profileNames.add(profile.name);
		if (typeof profile.imagePattern !== "string" || !profile.imagePattern) {
			throw new Error(`${prefix}.imagePattern must be a non-empty minimatch glob`);
		}
		if (profile.promptGuidance !== undefined) assertStringArray(profile.promptGuidance, `${prefix}.promptGuidance`);
		if (profile.network !== undefined) {
			if (profile.network === null || typeof profile.network !== "object" || Array.isArray(profile.network)) {
				throw new Error(`${prefix}.network must be an object`);
			}
			if (profile.network.dns !== undefined) {
				const dns = profile.network.dns;
				if (dns === null || typeof dns !== "object" || Array.isArray(dns)) {
					throw new Error(`${prefix}.network.dns must be an object`);
				}
				if (dns.mode !== undefined && !["open", "trusted", "synthetic"].includes(dns.mode)) {
					throw new Error(`${prefix}.network.dns.mode must be open, trusted, or synthetic`);
				}
				if (
					dns.syntheticHostMapping !== undefined &&
					!["single", "per-host"].includes(dns.syntheticHostMapping)
				) {
					throw new Error(`${prefix}.network.dns.syntheticHostMapping must be single or per-host`);
				}
			}
			if (profile.network.tcpHosts !== undefined) {
				if (
					profile.network.tcpHosts === null ||
					typeof profile.network.tcpHosts !== "object" ||
					Array.isArray(profile.network.tcpHosts) ||
					Object.entries(profile.network.tcpHosts).some(
						([alias, canonical]) => !alias || typeof canonical !== "string" || !canonical,
					)
				) {
					throw new Error(`${prefix}.network.tcpHosts must map aliases to canonical endpoints`);
				}
			}
		}
		if (profile.directories !== undefined && !Array.isArray(profile.directories)) {
			throw new Error(`${prefix}.directories must be an array`);
		}
		if (profile.files !== undefined && !Array.isArray(profile.files)) {
			throw new Error(`${prefix}.files must be an array`);
		}
		if (profile.mounts !== undefined && !Array.isArray(profile.mounts)) {
			throw new Error(`${prefix}.mounts must be an array`);
		}
		for (const [directoryIndex, directory] of (profile.directories ?? []).entries()) {
			if (!directory || typeof directory.path !== "string" || !path.posix.isAbsolute(directory.path)) {
				throw new Error(`${prefix}.directories[${directoryIndex}].path must be an absolute guest path`);
			}
			parseMode(directory.mode, `${prefix}.directories[${directoryIndex}].mode`);
		}
		for (const [fileIndex, file] of (profile.files ?? []).entries()) {
			const filePrefix = `${prefix}.files[${fileIndex}]`;
			if (!file || typeof file.destination !== "string" || !path.posix.isAbsolute(file.destination)) {
				throw new Error(`${filePrefix}.destination must be an absolute guest path`);
			}
			if ((typeof file.source === "string") === (typeof file.content === "string")) {
				throw new Error(`${filePrefix} must define exactly one of source or content`);
			}
			if (typeof file.source === "string" && file.source.length === 0) {
				throw new Error(`${filePrefix}.source must not be empty`);
			}
			if (file.required !== undefined && typeof file.required !== "boolean") {
				throw new Error(`${filePrefix}.required must be a boolean`);
			}
			parseMode(file.mode, `${filePrefix}.mode`);
		}

		const reservedMountPaths = ["/workspace", "/opt/pi-coding-agent"];
		const mountDestinations: string[] = [];
		for (const [mountIndex, mount] of (profile.mounts ?? []).entries()) {
			const mountPrefix = `${prefix}.mounts[${mountIndex}]`;
			if (!mount || typeof mount !== "object") throw new Error(`${mountPrefix} must be an object`);
			if (typeof mount.source !== "string" || mount.source.length === 0) {
				throw new Error(`${mountPrefix}.source must be a non-empty host directory path`);
			}
			if (
				typeof mount.destination !== "string" ||
				!path.posix.isAbsolute(mount.destination) ||
				path.posix.normalize(mount.destination) !== mount.destination
			) {
				throw new Error(`${mountPrefix}.destination must be a normalized absolute guest path`);
			}
			if (mount.required !== undefined && typeof mount.required !== "boolean") {
				throw new Error(`${mountPrefix}.required must be a boolean`);
			}
			const conflictsWith = [...reservedMountPaths, ...mountDestinations].find((existing) =>
				guestPathsOverlap(existing, mount.destination),
			);
			if (conflictsWith) {
				throw new Error(`${mountPrefix}.destination ${mount.destination} overlaps guest mount ${conflictsWith}`);
			}
			mountDestinations.push(mount.destination);
		}
	}
	return config;
}

export function loadConfig(configPath: string): SelectorConfig {
	if (!fs.existsSync(configPath)) return {};
	try {
		return validateConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
	} catch (error) {
		throw new Error(`Failed to load Gondolin selector configuration ${configPath}: ${(error as Error).message}`);
	}
}

export function selectProfile(reference: string, profiles: readonly GondolinProfileConfig[]): GondolinProfileConfig | undefined {
	const matches = profiles.filter((profile) => minimatch(reference, profile.imagePattern));
	if (matches.length > 1) {
		throw new Error(`Image ${reference} matches multiple Gondolin profiles: ${matches.map(({ name }) => name).join(", ")}`);
	}
	return matches[0];
}

export function findProfile(
	name: string,
	profiles: readonly GondolinProfileConfig[],
): GondolinProfileConfig {
	const matches = profiles.filter((profile) => profile.name === name);
	if (matches.length === 0) {
		const available = profiles.map((profile) => profile.name).join(", ") || "(none configured)";
		throw new Error(`Unknown Gondolin profile ${JSON.stringify(name)}. Available profiles: ${available}`);
	}
	if (matches.length > 1) throw new Error(`Multiple Gondolin profiles are named ${JSON.stringify(name)}`);
	return matches[0]!;
}

export function referencesForProfile(
	profile: GondolinProfileConfig,
	references: readonly string[],
): string[] {
	return references.filter((reference) => minimatch(reference, profile.imagePattern)).sort((left, right) =>
		left.localeCompare(right),
	);
}

export function resolveProfileReference(
	profileName: string,
	explicitImage: string | undefined,
	references: readonly string[],
	profiles: readonly GondolinProfileConfig[],
): string {
	const profile = findProfile(profileName, profiles);
	const matches = referencesForProfile(profile, references);

	if (explicitImage !== undefined) {
		if (!references.includes(explicitImage)) {
			throw new Error(`Gondolin image ${JSON.stringify(explicitImage)} is not available to the selector`);
		}
		const actualProfile = selectProfile(explicitImage, profiles);
		if (actualProfile?.name !== profile.name) {
			const actual = actualProfile ? `profile ${JSON.stringify(actualProfile.name)}` : "the generic profile";
			throw new Error(
				`Gondolin image ${JSON.stringify(explicitImage)} belongs to ${actual}, not profile ${JSON.stringify(profileName)}`,
			);
		}
		return explicitImage;
	}

	if (matches.length === 0) {
		throw new Error(
			`No locally tagged Gondolin image matches profile ${JSON.stringify(profileName)} (${profile.imagePattern})`,
		);
	}
	if (matches.length > 1) {
		throw new Error(
			`Profile ${JSON.stringify(profileName)} matches multiple Gondolin images: ${matches.join(", ")}. ` +
				"Select one with --gondolin-image <reference>.",
		);
	}
	selectProfile(matches[0]!, profiles); // Reject an image that also matches another profile.
	return matches[0]!;
}

export function filterReferences(references: readonly string[], imageFilter?: string): string[] {
	const regex = imageFilter ? new RegExp(imageFilter) : undefined;
	return references.filter((reference) => !regex || regex.test(reference));
}

export function prioritizeRemembered(references: readonly string[], remembered?: string): string[] {
	const sorted = [...references].sort((left, right) => left.localeCompare(right));
	if (!remembered || !sorted.includes(remembered)) return sorted;
	return [remembered, ...sorted.filter((reference) => reference !== remembered)];
}

export function readState(statePath: string): SelectorState {
	if (!fs.existsSync(statePath)) return { projects: {} };
	try {
		const value = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("state must be an object");
		const projects = (value as { projects?: unknown }).projects;
		if (!projects || typeof projects !== "object" || Array.isArray(projects)) throw new Error("projects must be an object");
		if (Object.entries(projects).some(([project, reference]) => !project || typeof reference !== "string")) {
			throw new Error("projects must map canonical paths to image references");
		}
		return { projects: projects as Record<string, string> };
	} catch (error) {
		throw new Error(`Failed to load Gondolin selector state ${statePath}: ${(error as Error).message}`);
	}
}

export function writeStateAtomic(statePath: string, state: SelectorState): void {
	fs.mkdirSync(path.dirname(statePath), { recursive: true });
	const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporaryPath, statePath);
		fs.chmodSync(statePath, 0o600);
	} finally {
		try {
			fs.unlinkSync(temporaryPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}
