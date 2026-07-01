#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const PROFILE_DIR = join(REPO_ROOT, "docs", "profiles");
const LOCK_PATH = join(PROFILE_DIR, "oh-my-pi.profile-lock.json");
const PROFILE_SCHEMA = "./profile-pack.schema.json";
const LOCK_SCHEMA = "./profile-lock.schema.json";
const CORE_PACKAGE_INSTALL_SPEC = "git:github.com/zzanghyunmoo/oh-my-pi";
const SECRET_VALUE_FIELD_NAMES = new Set([
	"value",
	"defaultValue",
	"localValue",
	"secretValue",
	"apiKey",
	"token",
	"password",
]);

function repoPath(path) {
	return relative(REPO_ROOT, path).replaceAll("\\", "/");
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${repoPath(path)} is not valid JSON: ${error.message}`);
	}
}

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])]),
		);
	}
	return value;
}

function canonicalString(value) {
	return JSON.stringify(canonicalize(value));
}

function sha256(value) {
	return createHash("sha256").update(canonicalString(value)).digest("hex");
}

function unique(values) {
	return [...new Set(values)];
}

function getSelectedExtensionPaths(profile) {
	const selected = (profile.extensionToggles ?? [])
		.filter((toggle) => toggle.enabledByDefault)
		.map((toggle) => toggle.extensionPath);
	return unique(
		selected.length > 0 ? selected : profile.piPackage.extensions,
	);
}

function toPackageFilterPath(path) {
	return path.replace(/^\.\//, "");
}

function buildCorePackageSettingsEntry(profile) {
	return {
		source: CORE_PACKAGE_INSTALL_SPEC,
		extensions: getSelectedExtensionPaths(profile).map(toPackageFilterPath),
		prompts: profile.piPackage.prompts.map(toPackageFilterPath),
		themes: profile.piPackage.themes.map(toPackageFilterPath),
	};
}

function buildPackageSettingsEntries(profile) {
	return profile.packageRefs.map((ref) =>
		ref.installSpec === CORE_PACKAGE_INSTALL_SPEC
			? buildCorePackageSettingsEntry(profile)
			: ref.installSpec,
	);
}

function printIndentedJson(value) {
	for (const line of prettyJson(value).trimEnd().split("\n")) {
		console.log(`  ${line}`);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function loadProfileFiles() {
	return readdirSync(PROFILE_DIR)
		.filter((name) => name.endsWith(".profile.json"))
		.sort()
		.map((name) => join(PROFILE_DIR, name));
}

function collectBlueprintEnvNames(secretBlueprint) {
	const environment = secretBlueprint.environment ?? {};
	return new Set([
		...(environment.toggles ?? []).map((entry) => entry.name),
		...(environment.configuration ?? []).map((entry) => entry.name),
		...(environment.secrets ?? []).map((entry) => entry.name),
	]);
}

function collectSettingsPackageSpecs(settingsExample) {
	return new Set(settingsExample.packages ?? []);
}

function ensureNoSecretValueFields(value, path = "profile") {
	if (Array.isArray(value)) {
		value.forEach((entry, index) =>
			ensureNoSecretValueFields(entry, `${path}[${index}]`),
		);
		return;
	}

	if (!value || typeof value !== "object") return;

	for (const [key, entry] of Object.entries(value)) {
		assert(
			!SECRET_VALUE_FIELD_NAMES.has(key),
			`${path}.${key} must not store a secret/local value`,
		);
		ensureNoSecretValueFields(entry, `${path}.${key}`);
	}
}

function validateProfile(profile, context, seenIds) {
	const { packageJson, settingsSpecs, blueprintNames } = context;
	assert(
		profile.$schema === PROFILE_SCHEMA,
		`${profile.id ?? "unknown"}: $schema must be ${PROFILE_SCHEMA}`,
	);
	assert(
		profile.schemaVersion === "0.1.0",
		`${profile.id}: unsupported schemaVersion ${profile.schemaVersion}`,
	);
	assert(
		/^[a-z][a-z0-9-]*$/.test(profile.id),
		`${profile.id}: invalid profile id`,
	);
	assert(!seenIds.has(profile.id), `${profile.id}: duplicate profile id`);
	seenIds.add(profile.id);
	ensureNoSecretValueFields(profile, profile.id);

	const packageExtensions = new Set(packageJson.pi?.extensions ?? []);
	const packagePrompts = new Set(packageJson.pi?.prompts ?? []);
	const packageThemes = new Set(packageJson.pi?.themes ?? []);

	assert(
		Array.isArray(profile.packageRefs) && profile.packageRefs.length > 0,
		`${profile.id}: packageRefs must not be empty`,
	);
	const installSpecs = new Set();
	for (const ref of profile.packageRefs) {
		assert(
			ref.name &&
				ref.installSpec &&
				ref.source &&
				typeof ref.required === "boolean" &&
				ref.intent,
			`${profile.id}: packageRefs entries must include name/installSpec/source/required/intent`,
		);
		assert(
			!installSpecs.has(ref.installSpec),
			`${profile.id}: duplicate package installSpec ${ref.installSpec}`,
		);
		installSpecs.add(ref.installSpec);
		if (ref.source === "settings-example") {
			assert(
				settingsSpecs.has(ref.installSpec),
				`${profile.id}: ${ref.installSpec} is marked settings-example but is not in settings.example.json`,
			);
		}
	}
	assert(
		installSpecs.has(CORE_PACKAGE_INSTALL_SPEC),
		`${profile.id}: must include oh-my-pi core package ref`,
	);

	for (const extensionPath of profile.piPackage?.extensions ?? []) {
		assert(
			packageExtensions.has(extensionPath),
			`${profile.id}: piPackage extension ${extensionPath} is not in package.json pi.extensions`,
		);
	}
	for (const promptPath of profile.piPackage?.prompts ?? []) {
		assert(
			packagePrompts.has(promptPath),
			`${profile.id}: piPackage prompt ${promptPath} is not in package.json pi.prompts`,
		);
	}
	for (const themePath of profile.piPackage?.themes ?? []) {
		assert(
			packageThemes.has(themePath),
			`${profile.id}: piPackage theme ${themePath} is not in package.json pi.themes`,
		);
	}

	const toggleExtensionPaths = new Set();
	for (const toggle of profile.extensionToggles ?? []) {
		assert(
			toggle.extensionId &&
				toggle.extensionPath &&
				typeof toggle.enabledByDefault === "boolean",
			`${profile.id}: invalid extension toggle entry`,
		);
		assert(
			packageExtensions.has(toggle.extensionPath),
			`${profile.id}: toggle extensionPath ${toggle.extensionPath} is not in package.json pi.extensions`,
		);
		assert(
			!toggleExtensionPaths.has(toggle.extensionPath),
			`${profile.id}: duplicate extension toggle for ${toggle.extensionPath}`,
		);
		toggleExtensionPaths.add(toggle.extensionPath);
		if (toggle.toggleEnvVar)
			assert(
				blueprintNames.has(toggle.toggleEnvVar),
				`${profile.id}: toggle ${toggle.toggleEnvVar} is not in secret blueprint`,
			);
	}

	for (const secretRef of profile.secretRefs ?? []) {
		assert(
			blueprintNames.has(secretRef.name),
			`${profile.id}: secretRef ${secretRef.name} is not in docs/blueprints/oh-my-pi.secret-blueprint.json`,
		);
		assert(
			secretRef.commitPolicy !== "never-commit-oauth-state" ||
				secretRef.kind === "oauth-state",
			`${profile.id}: oauth commit policy must use oauth-state kind`,
		);
	}

	const secretRefNames = new Set(
		(profile.secretRefs ?? []).map((entry) => entry.name),
	);
	for (const provider of profile.providers ?? []) {
		assert(
			secretRefNames.has(provider.toggleEnvVar),
			`${profile.id}: provider ${provider.id} toggle ${provider.toggleEnvVar} must be listed in secretRefs`,
		);
		for (const refName of provider.requiredSecretRefs ?? []) {
			assert(
				secretRefNames.has(refName),
				`${profile.id}: provider ${provider.id} requiredSecretRef ${refName} must be listed in secretRefs`,
			);
		}
	}

	for (const metadataPath of Object.values(profile.metadataRefs ?? {})) {
		assert(
			existsSync(join(REPO_ROOT, metadataPath)),
			`${profile.id}: metadataRef ${metadataPath} does not exist`,
		);
	}
}

function makeLock(profiles, profileFiles) {
	return {
		$schema: LOCK_SCHEMA,
		schemaVersion: "0.1.0",
		generatedBy: "node scripts/profile-pack.mjs lock --write",
		profileFiles: profileFiles.map(repoPath),
		profiles: profiles.map((profile, index) => ({
			id: profile.id,
			source: repoPath(profileFiles[index]),
			sha256: sha256(profile),
			packages: profile.packageRefs.map((ref) => ref.installSpec),
			extensions: profile.piPackage.extensions,
			enabledToggles: profile.extensionToggles
				.filter((toggle) => toggle.enabledByDefault && toggle.toggleEnvVar)
				.map((toggle) => `${toggle.toggleEnvVar}=true`),
			secretRefNames: (profile.secretRefs ?? []).map((entry) => entry.name),
			connectors: (profile.connectors ?? []).map((entry) => entry.id),
			providers: (profile.providers ?? []).map((entry) => entry.id),
			prompts: profile.piPackage.prompts,
			themes: profile.piPackage.themes,
		})),
	};
}

function prettyJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function loadAndValidateProfiles() {
	const packageJson = readJson(join(REPO_ROOT, "package.json"));
	const settingsExample = readJson(join(REPO_ROOT, "settings.example.json"));
	const secretBlueprint = readJson(
		join(REPO_ROOT, "docs", "blueprints", "oh-my-pi.secret-blueprint.json"),
	);
	const context = {
		packageJson,
		settingsSpecs: collectSettingsPackageSpecs(settingsExample),
		blueprintNames: collectBlueprintEnvNames(secretBlueprint),
	};

	const profileFiles = loadProfileFiles();
	assert(
		profileFiles.length > 0,
		"No *.profile.json files found under docs/profiles",
	);
	const profiles = profileFiles.map(readJson);
	const seenIds = new Set();
	for (const profile of profiles) validateProfile(profile, context, seenIds);
	assert(
		profiles.some((profile) =>
			profile.packageRefs.some((ref) => ref.installSpec === "npm:pi-clear"),
		),
		"At least one profile must record the npm:pi-clear manual install signal",
	);
	return { profiles, profileFiles };
}

function verifyLock(expectedLock) {
	assert(
		existsSync(LOCK_PATH),
		`${repoPath(LOCK_PATH)} is missing; run npm run profile:lock`,
	);
	const actualText = readFileSync(LOCK_PATH, "utf8");
	const expectedText = prettyJson(expectedLock);
	assert(
		actualText === expectedText,
		`${repoPath(LOCK_PATH)} is stale; run npm run profile:lock`,
	);
}

function commandVerify() {
	const { profiles, profileFiles } = loadAndValidateProfiles();
	const expectedLock = makeLock(profiles, profileFiles);
	verifyLock(expectedLock);
	console.log(
		`profile:verify ok — ${profiles.length} profiles and ${repoPath(LOCK_PATH)} are deterministic and secret-free.`,
	);
}

function commandLock(args) {
	const write = args.includes("--write");
	const { profiles, profileFiles } = loadAndValidateProfiles();
	const lock = makeLock(profiles, profileFiles);
	const output = prettyJson(lock);
	if (write) {
		writeFileSync(LOCK_PATH, output, "utf8");
		console.log(
			`Wrote ${repoPath(LOCK_PATH)} for ${profiles.length} profiles.`,
		);
		return;
	}
	process.stdout.write(output);
}

function commandApply(args) {
	const profileFlagIndex = args.indexOf("--profile");
	const profileId =
		profileFlagIndex >= 0 ? args[profileFlagIndex + 1] : "default";
	assert(profileId, "--profile requires a profile id");
	const { profiles, profileFiles } = loadAndValidateProfiles();
	verifyLock(makeLock(profiles, profileFiles));
	const profile = profiles.find((entry) => entry.id === profileId);
	assert(
		profile,
		`Unknown profile ${profileId}; available profiles: ${profiles.map((entry) => entry.id).join(", ")}`,
	);

	const packageCommands = profile.packageRefs.map(
		(ref) =>
			`pi install ${ref.installSpec}${ref.required ? "" : "  # optional intent"}`,
	);
	const selectedExtensions = getSelectedExtensionPaths(profile);
	const settingsPackageEntries = buildPackageSettingsEntries(profile);
	const envLines = profile.extensionToggles
		.filter((toggle) => toggle.toggleEnvVar && toggle.requiredValue === "true")
		.map((toggle) => `${toggle.toggleEnvVar}=true`);
	const secretPlaceholders = (profile.secretRefs ?? [])
		.filter((entry) => entry.commitPolicy === "never-commit-value")
		.map((entry) => `${entry.name}=<local-${entry.kind}>`);
	const connectorLogins = (profile.connectors ?? [])
		.map((connector) => connector.loginCommand)
		.filter(Boolean);
	const providerChecks = (profile.providers ?? [])
		.map((provider) => provider.statusCommand)
		.filter(Boolean);

	console.log(`oh-my-pi profile apply plan (dry-run): ${profile.id}`);
	console.log("");
	console.log(
		"This command is intentionally non-destructive: it does not run pi install, write .env, or start OAuth.",
	);
	console.log("");
	console.log("Install intent:");
	for (const command of packageCommands) console.log(`  ${command}`);
	console.log("");
	console.log("Selected oh-my-pi extensions for this profile:");
	for (const extensionPath of selectedExtensions) console.log(`  ${extensionPath}`);
	console.log("");
	console.log(
		"Optional settings.json packages entry for selected resources:",
	);
	printIndentedJson({ packages: settingsPackageEntries });
	console.log("");
	console.log("Local CWD .env entries to create manually when needed:");
	const localEnvLines = [...envLines, ...secretPlaceholders];
	if (localEnvLines.length === 0) console.log("  (none)");
	for (const line of localEnvLines) console.log(`  ${line}`);
	console.log("");
	console.log("Connector/provider follow-up:");
	const followUps = [...connectorLogins, ...providerChecks];
	if (followUps.length === 0) console.log("  (none)");
	for (const followUp of followUps) console.log(`  ${followUp}`);
}

function printHelp() {
	console.log(
		`Usage: node scripts/profile-pack.mjs <command> [options]\n\nCommands:\n  verify                 Validate profile JSON and deterministic lock receipt.\n  lock [--write]         Print or write docs/profiles/oh-my-pi.profile-lock.json.\n  apply [--profile id]   Print a non-destructive apply plan (default profile: default).`,
	);
}

try {
	const [command = "help", ...args] = process.argv.slice(2);
	if (command === "verify") commandVerify();
	else if (command === "lock") commandLock(args);
	else if (command === "apply") commandApply(args);
	else {
		printHelp();
		if (command !== "help" && command !== "--help" && command !== "-h")
			process.exitCode = 1;
	}
} catch (error) {
	console.error(`profile-pack error: ${error.message}`);
	process.exitCode = 1;
}
