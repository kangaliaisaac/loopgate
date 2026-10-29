import { join } from 'node:path';

export interface Gate {
	name: string;
	command: string;
	args: string[];
	/** Longest the gate may run; `DEFAULT_GATE_TIMEOUT_MS` when unset. */
	timeoutMs?: number;
	/** Needs a `*_test` database named by `testDatabaseEnv`; refused otherwise, before running. */
	needsTestDb?: boolean;
}

/** A path in a diff that should be reviewed by the stronger model. */
export interface SensitivePath {
	pattern: RegExp;
	label: string;
}

/** What a repo's `loopgate.json` says, with defaults filled in. */
export interface LoopgateConfig {
	gates: Gate[];
	/** What the gates need in the work tree that git does not carry (a fresh worktree lacks it). */
	environment?: { path: string; fix: string };
	testDatabaseEnv: string;
	siblingRepos: string[];
	sensitivePaths: SensitivePath[];
}

export const CONFIG_FILE = 'loopgate.json';

/** A gate that runs this long is hung (a stalled network call, a deadlocked test). */
export const DEFAULT_GATE_TIMEOUT_MS = 20 * 60 * 1000;

export class ConfigError extends Error {}

const KEYS = ['gates', 'environment', 'testDatabaseEnv', 'siblingRepos', 'sensitivePaths'];
const GATE_KEYS = ['name', 'command', 'args', 'timeoutMs', 'needsTestDb'];

function fail(key: string, expected: string): never {
	throw new ConfigError(`${CONFIG_FILE}: "${key}" must be ${expected}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, key: string): string {
	return typeof value === 'string' && value !== '' ? value : fail(key, 'a non-empty string');
}

function strings(value: unknown, key: string): string[] {
	return Array.isArray(value) && value.every((v) => typeof v === 'string')
		? (value as string[])
		: fail(key, 'an array of strings');
}

function object(value: unknown, key: string, allowed: string[]): Record<string, unknown> {
	if (!isRecord(value)) return fail(key, 'an object');
	const extra = Object.keys(value).find((name) => !allowed.includes(name));
	if (extra !== undefined) return fail(`${key}.${extra}`, `one of ${allowed.join(', ')}`);
	return value;
}

function parseGate(value: unknown, key: string): Gate {
	const raw = object(value, key, GATE_KEYS);
	const gate: Gate = {
		name: text(raw['name'], `${key}.name`),
		command: text(raw['command'], `${key}.command`),
		args: raw['args'] === undefined ? [] : strings(raw['args'], `${key}.args`)
	};
	const timeout = raw['timeoutMs'];
	if (timeout !== undefined) {
		if (typeof timeout !== 'number' || !(timeout > 0))
			fail(`${key}.timeoutMs`, 'a positive number');
		gate.timeoutMs = timeout;
	}
	const needsTestDb = raw['needsTestDb'];
	if (needsTestDb !== undefined) {
		if (typeof needsTestDb !== 'boolean') fail(`${key}.needsTestDb`, 'true or false');
		gate.needsTestDb = needsTestDb;
	}
	return gate;
}

function parseSensitive(value: unknown, key: string): SensitivePath {
	const raw = object(value, key, ['pattern', 'label']);
	const source = text(raw['pattern'], `${key}.pattern`);
	let pattern: RegExp;
	try {
		pattern = new RegExp(source);
	} catch {
		return fail(`${key}.pattern`, 'a valid regular expression');
	}
	return { pattern, label: text(raw['label'], `${key}.label`) };
}

function list<T>(value: unknown, key: string, parse: (item: unknown, key: string) => T): T[] {
	if (!Array.isArray(value)) return fail(key, 'an array');
	return value.map((item, index) => parse(item, `${key}[${index}]`));
}

/** The config in `source`; throws `ConfigError` naming the offending key. */
export function parseConfig(source: string): LoopgateConfig {
	let json: unknown;
	try {
		json = JSON.parse(source);
	} catch {
		throw new ConfigError(`${CONFIG_FILE} is not valid JSON.`);
	}
	const raw = object(json, 'config', KEYS);
	const config: LoopgateConfig = {
		gates: list(raw['gates'], 'gates', parseGate),
		testDatabaseEnv:
			raw['testDatabaseEnv'] === undefined
				? 'DATABASE_URL'
				: text(raw['testDatabaseEnv'], 'testDatabaseEnv'),
		siblingRepos:
			raw['siblingRepos'] === undefined ? [] : strings(raw['siblingRepos'], 'siblingRepos'),
		sensitivePaths:
			raw['sensitivePaths'] === undefined
				? []
				: list(raw['sensitivePaths'], 'sensitivePaths', parseSensitive)
	};
	if (raw['environment'] !== undefined) {
		const env = object(raw['environment'], 'environment', ['path', 'fix']);
		config.environment = {
			path: text(env['path'], 'environment.path'),
			fix: text(env['fix'], 'environment.fix')
		};
	}
	return config;
}

/**
 * The config at the top of a work tree, or undefined when the repo has none (no gates). Looked up
 * at `top` only: there is no search upward and no global default.
 */
export function loadConfig(
	top: string,
	readFile: (path: string) => string | undefined
): LoopgateConfig | undefined {
	const source = readFile(join(top, CONFIG_FILE));
	return source === undefined ? undefined : parseConfig(source);
}

/** Like `loadConfig`, but an invalid file comes back as its error message. */
export function configOrMessage(
	top: string,
	readFile: (path: string) => string | undefined
): LoopgateConfig | string | undefined {
	try {
		return loadConfig(top, readFile);
	} catch (error) {
		if (error instanceof ConfigError) return error.message;
		throw error;
	}
}

/** Database name from a `DATABASE_URL` (the path's last segment, without query). */
export function databaseName(url: string | undefined): string | undefined {
	const match = /\/([^/?#]+)(?:[?#].*)?$/.exec(url ?? '');
	return match?.[1];
}

/** Host of a `DATABASE_URL`, or undefined when the URL does not parse. */
export function databaseHost(url: string | undefined): string | undefined {
	try {
		return new URL(url ?? '').hostname;
	} catch {
		return undefined;
	}
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** libpq query parameters that replace the host or database the URL names. */
const OVERRIDING_PARAMS = ['host', 'hostaddr', 'dbname', 'service'];

function overridesTarget(url: string | undefined): boolean {
	const query = /\?([^#]*)/.exec(url ?? '')?.[1] ?? '';
	const params = new URLSearchParams(query);
	return OVERRIDING_PARAMS.some((name) => params.has(name));
}

/** A `*_test` database on this machine: the gates may migrate and write to it. */
export function isTestDatabase(url: string | undefined): boolean {
	return (
		!overridesTarget(url) &&
		(databaseName(url) ?? '').endsWith('_test') &&
		LOCAL_HOSTS.has(databaseHost(url) ?? '')
	);
}
