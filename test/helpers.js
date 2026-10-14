/**
 * Test doubles shared by the plugin tests.
 *
 * Not a test file: it exports the stub Host context, the config builder and the
 * fake OpenSpec CLI. It lives here rather than being repeated in each test file
 * because the stub context is the only thing standing in for a running Host, and
 * two copies of it would drift into testing two different Hosts.
 */

import { chmodSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Config } from '../host/plugin.js';

/**
 * A context with just enough of Cordis to run `apply`.
 *
 * Registration is captured rather than performed: the services themselves
 * validate what they are given, and a stub that silently accepted a malformed
 * definition would make every assertion here worthless. So `register` records the
 * argument and the tests assert its shape.
 *
 * @param {object} t - the node:test context, for teardown.
 * @param {object} [options] - stub options.
 * @param {boolean} [options.withCommands] - whether `commands` is present.
 * @param {boolean} [options.withTools] - whether `tools` is present.
 * @param {string} [options.cwd] - the working directory `session-1` reports.
 * @returns {object} the context and everything registered on it.
 */
export function stubContext(t, { withCommands = true, withTools = true, cwd = process.cwd() } = {}) {
	const effects = [];
	const commands = [];
	const tools = [];
	const routes = [];
	const logs = [];
	const registered = {};
	if (withCommands) {
		registered.commands = {
			register: (definition) => {
				commands.push(definition);
				return () => {};
			},
		};
	}
	if (withTools) {
		registered.tools = {
			register: (definition) => {
				tools.push(definition);
				return () => {};
			},
		};
	}

	const ctx = {
		logger: { info: (message) => logs.push(message) },
		sessions: { get: (id) => (id === 'session-1' ? { header: { cwd } } : undefined) },
		agents: { get: (id) => (id === 'session-1' ? liveAgent(cwd) : undefined) },
		sessionController: {
			// The seam resolves a session to a live agent before it will prompt it, so
			// a stub without this reports "no such session" for every message.
			resolveAgent: async (id) => (id === 'session-1' ? { agent: liveAgent(cwd) } : { error: { code: 'NOT_FOUND' } }),
			create: async () => ({ sessionId: 'session-1' }),
			prompt: async () => ({ admitted: true }),
			cancel: () => {},
		},
		webServer: {
			register: (route) => {
				routes.push(route);
				return () => {};
			},
		},
		effect: (factory) => {
			const dispose = factory();
			effects.push(dispose);
			return () => {};
		},
		on: () => () => {},
		inject: (keys, callback) => {
			const scoped = {};
			for (const key of keys) {
				// A service the composition does not provide is not injected at all,
				// which is the behaviour the plugin has to survive.
				if (registered[key] === undefined) return () => {};
				scoped[key] = registered[key];
			}
			const dispose = callback(scoped);
			return typeof dispose === 'function' ? dispose : () => {};
		},
	};
	t.after(() => {
		for (const dispose of effects.reverse()) {
			try {
				if (typeof dispose === 'function') dispose();
			} catch {
				/* A teardown that throws is not what these tests are about. */
			}
		}
	});
	return { ctx, commands, tools, routes, logs, effects };
}

/**
 * A minimal live agent for `session-1`.
 * @param {string} cwd - its working directory.
 * @returns {object} the agent.
 */
function liveAgent(cwd) {
	return { id: 'session-1', status: 'idle', session: { id: 'session-1', cwd } };
}

/**
 * A plugin config that keeps the durable document inside a scratch directory.
 * @param {string} dir - the scratch directory.
 * @param {object} [extra] - further settings.
 * @returns {object} the validated config.
 */
export function configFor(dir, extra = {}) {
	return Config['~standard'].validate({ file: join(dir, 'state.json'), ...extra }).value;
}

/**
 * A fake `openspec` that answers the calls the plugin actually makes.
 *
 * A shell script rather than a stubbed `Openspec`, because the interesting part
 * of this flow is precisely that the plugin shells out: the arguments it builds,
 * the exit codes it handles, and the files it writes afterwards. Replacing the
 * class would test the replacement.
 *
 * `new change` really creates the directory, so the artifacts the plugin writes
 * afterwards land where a real change would keep them.
 *
 * @param {string} dir - a scratch directory to put the script in.
 * @param {object} [behaviour] - knobs.
 * @param {boolean} [behaviour.failValidate] - make `validate` exit non-zero.
 * @param {number} [behaviour.totalTasks] - the task count `list` reports.
 * @param {number} [behaviour.completedTasks] - the completed count `list` reports.
 * @returns {string} the executable's path.
 */
export function fakeOpenspec(dir, { failValidate = false, totalTasks = 4, completedTasks = 1 } = {}) {
	const path = join(dir, 'fake-openspec');
	// The task counts and the validate verdict are baked in rather than read from
	// the environment: each test builds the CLI it needs, which keeps the fixture
	// readable at the call site.
	const script = `#!/bin/sh
set -e
command="$1"
shift || true
case "$command" in
	init)
		mkdir -p openspec/changes
		printf 'schema: spec-driven\\n' > openspec/config.yaml
		echo '{"initialized":true}'
		;;
	new)
		# new change <id> --json --no-color [--description x]
		[ "$1" = "change" ] || exit 2
		id="$2"
		mkdir -p "openspec/changes/$id"
		printf 'schema: spec-driven\\n' > "openspec/changes/$id/.openspec.yaml"
		echo "{\\"change\\":{\\"id\\":\\"$id\\"}}"
		;;
	validate)
		if [ "${failValidate ? '1' : '0'}" = "1" ]; then
			echo 'specs/x/spec.md: requirement has no scenario' >&2
			exit 1
		fi
		echo "Change '$1' is valid"
		;;
	list)
		# Describe the directories that actually exist, so a test asserting on the
		# refreshed tally is asserting on the plugin's own bookkeeping.
		printf '{"changes":['
		first=1
		for d in openspec/changes/*/; do
			[ -d "$d" ] || continue
			id=$(basename "$d")
			[ "$id" = "archive" ] && continue
			if [ $first = 0 ]; then printf ','; fi
			first=0
			printf '{"name":"%s","totalTasks":${totalTasks},"completedTasks":${completedTasks}}' "$id"
		done
		printf ']}'
		;;
	instructions)
		echo '{"progress":{"total":${totalTasks},"complete":${completedTasks},"remaining":0},"tasks":[],"state":"ready","instruction":"","contextFiles":[]}'
		;;
	*)
		echo "unexpected: $command" >&2
		exit 3
		;;
esac
`;
	writeFileSync(path, script, 'utf8');
	chmodSync(path, 0o755);
	return path;
}

/**
 * The change ids the fake CLI created under a project.
 * @param {string} projectPath - the project directory.
 * @returns {string[]} the ids, sorted.
 */
export function createdChanges(projectPath) {
	return readdirSync(join(projectPath, 'openspec', 'changes'), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

// ---------------------------------------------------------------------------
// The two registries' admission rules, mirrored from the shipped services.
//
// `cmd.tools.register()` validates a definition with `assertSupportedJsonSchema`
// and `cmd.commands.register()` with `normalizeDefinition`, and both throw on a
// definition that does not fit. Neither service is importable from an installed
// plugin — the runtime packages live in the application's own module graph — so
// the rules are restated here, from the shipped source, and asserted against the
// real definitions in `contract.test.js`.
//
// This is a mirror, not the authority: on a DSH upgrade the shipped validators
// are what decide, and these copies may need to follow. They earn their place by
// turning "the plugin registered a tool the registry would reject" from a
// runtime failure in a user's session into a failing test.
// ---------------------------------------------------------------------------

/** The schema keywords the tool registry accepts, beyond annotations. */
const CONSTRAINT_KEYWORDS = new Set([
	'type',
	'oneOf',
	'properties',
	'required',
	'additionalProperties',
	'items',
	'enum',
	'const',
]);

/** The keywords that only annotate, and must hold lossless JSON. */
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);

/** The schema types the registry understands. */
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

/** Keywords that may not sit beside `oneOf`. */
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];

/** Which type each keyword belongs to. */
const KEYWORD_TYPES = {
	properties: ['object'],
	required: ['object'],
	additionalProperties: ['object'],
	items: ['array'],
	enum: ['string', 'number', 'integer', 'boolean', 'null'],
	const: ['string', 'number', 'integer', 'boolean', 'null'],
};

/** Whether a value is a JSON array of JSON values. */
function isJsonValue(value) {
	if (value === null) return true;
	const type = typeof value;
	if (type === 'string' || type === 'boolean') return true;
	if (type === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (type === 'object') {
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
		return Object.values(value).every(isJsonValue);
	}
	return false;
}

/**
 * Collect every violation of the tool registry's supported schema subset.
 *
 * A faithful restatement of the shipped walker, which is iterative rather than
 * recursive so a deeply nested schema cannot exhaust the call stack. The order
 * of the violations does not matter; only their presence does.
 *
 * @param {unknown} root - the candidate schema.
 * @returns {string[]} one message per violation.
 */
export function schemaViolations(root) {
	const violations = [];
	const seen = new WeakSet();
	const walk = (node, path) => {
		if (node === null || typeof node !== 'object' || Array.isArray(node)) {
			violations.push(`${path} must be a schema object`);
			return;
		}
		if (seen.has(node)) {
			violations.push(`${path} is circular`);
			return;
		}
		seen.add(node);
		for (const key of Object.keys(node)) {
			if (CONSTRAINT_KEYWORDS.has(key)) continue;
			if (ANNOTATION_KEYWORDS.has(key)) {
				if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`);
				continue;
			}
			violations.push(`${path}.${key} is not a supported keyword`);
		}
		if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
			violations.push(`${path}.description must be a string`);
		}
		if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') violations.push(`${path}.title must be a string`);

		const hasType = Object.hasOwn(node, 'type');
		const hasOneOf = Object.hasOwn(node, 'oneOf');
		if (hasType && hasOneOf) {
			violations.push(`${path} cannot declare both type and oneOf`);
			return;
		}
		if (!hasType && !hasOneOf) {
			for (const key of ONE_OF_SIBLING_KEYWORDS) {
				if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
			}
			return;
		}
		if (hasOneOf) {
			for (const key of ONE_OF_SIBLING_KEYWORDS) {
				if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`);
			}
			if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
				violations.push(`${path}.oneOf must be an array of at least two schemas`);
			} else {
				for (const [index, child] of node.oneOf.entries()) walk(child, `${path}.oneOf[${index}]`);
			}
			return;
		}

		const type = node.type;
		if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
			violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`);
			return;
		}
		for (const [key, types] of Object.entries(KEYWORD_TYPES)) {
			if (Object.hasOwn(node, key) && !types.includes(type)) {
				violations.push(`${path}.${key} is not supported on type "${type}"`);
			}
		}
		if (type === 'object') {
			if (Object.hasOwn(node, 'properties')) {
				if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
					violations.push(`${path}.properties must be an object of schemas`);
				} else {
					for (const [name, child] of Object.entries(node.properties)) {
						walk(child, `${path}.properties.${name}`);
					}
				}
			}
			// The object tail: `required` names declared properties, and
			// `additionalProperties` is a boolean.
			if (Object.hasOwn(node, 'required')) {
				const required = node.required;
				if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
					violations.push(`${path}.required must be an array of strings`);
				} else {
					const declared = node.properties !== null && typeof node.properties === 'object' ? node.properties : {};
					for (const key of required) {
						if (!Object.hasOwn(declared, key)) {
							violations.push(`${path}.required names "${key}" which is not in properties`);
						}
					}
				}
			}
			if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
				violations.push(`${path}.additionalProperties must be a boolean`);
			}
		}
		if (type === 'array' && Object.hasOwn(node, 'items')) walk(node.items, `${path}.items`);
	};
	walk(root, 'schema');
	return violations;
}

/**
 * Assert a schema satisfies the tool registry's supported subset.
 * @param {unknown} schema - the candidate.
 */
export function assertSupportedJsonSchema(schema) {
	const violations = schemaViolations(schema);
	if (violations.length > 0) {
		throw new Error(`unsupported JSON Schema:\n  ${violations.join('\n  ')}`);
	}
}

/** The command registry's name grammar. */
export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u;

/**
 * Check a command definition the way `commands.register()` does.
 *
 * @param {unknown} definition - the candidate.
 * @returns {string[]} one message per problem.
 */
export function commandDefinitionViolations(definition) {
	const problems = [];
	if (definition === null || typeof definition !== 'object') return ['not an object'];
	if (!COMMAND_NAME_PATTERN.test(definition.name)) {
		problems.push(`name "${definition.name}" must match ${String(COMMAND_NAME_PATTERN)}`);
	}
	if (typeof definition.description !== 'string') problems.push('description must be a string');
	else if (definition.description.trim().length === 0) problems.push('description must not be empty');
	if (typeof definition.handler !== 'function') problems.push('handler must be a function');
	if (definition.input !== undefined) {
		if (definition.input === null || typeof definition.input !== 'object' || typeof definition.input.hint !== 'string') {
			problems.push('input.hint must be a string');
		} else if (definition.input.hint.trim().length === 0) {
			problems.push('input.hint must not be empty');
		}
	}
	return problems;
}

/**
 * Check a command handler's return value the way `normalizeResult` does.
 *
 * The registry detaches the result at the boundary and throws on a malformed
 * one, which would surface as a broken command rather than a message.
 *
 * @param {unknown} result - what the handler returned.
 * @returns {string[]} one message per problem.
 */
export function commandResultViolations(result) {
	if (result === null || typeof result !== 'object') return ['handler must return a CommandResult'];
	if (result.kind === 'success') {
		return result.text === undefined || typeof result.text === 'string' ? [] : ['success text must be a string'];
	}
	if (result.kind === 'error') {
		return typeof result.text === 'string' && result.text.trim().length > 0
			? []
			: ['error text must be a non-empty string'];
	}
	return [`unknown result kind "${String(result.kind)}"`];
}
