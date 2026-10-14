/**
 * The definitions the plugin hands to two services that validate them.
 *
 * `commands.register()` and `tools.register()` both throw on a definition that
 * does not fit their contract, and a throw inside `apply()` costs the *whole*
 * plugin — the page, the routes, the loop — not just the one registration. So
 * these tests check the definitions against the registries' own rules before a
 * user ever gets a chance to find out the hard way.
 *
 * The rules are restated in `test/helpers.js`; see the note there about which of
 * the two copies is the authority.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSpecCommand } from '../host/command.js';
import { TOOL_NAME, createProposeTool } from '../host/tool.js';
import {
	assertSupportedJsonSchema,
	commandDefinitionViolations,
	commandResultViolations,
	schemaViolations,
} from './helpers.js';

/** A store that knows nothing, which is all these tests need. */
const blankStore = {
	draft: () => undefined,
	clearDraft: () => {},
	saveDraft: () => {},
	changes: () => [],
	settings: () => ({ ralphIterations: 3 }),
};

/** The command under test, with inert collaborators. */
function specCommand() {
	return createSpecCommand({
		store: blankStore,
		proposals: {},
		sessions: { submit: async () => ({ ok: true }) },
		projectOfSession: () => undefined,
		commandFor: () => 'openspec',
	});
}

/** The tool under test, with inert collaborators. */
function proposeTool() {
	return createProposeTool({ store: blankStore, projectOfSession: () => undefined });
}

test('the tool parameters are a schema the registry supports', () => {
	// Read from the definition rather than from a private constant: the schema the
	// registry validates is the one on the tool it is handed.
	const { parameters } = proposeTool();
	assert.deepEqual(schemaViolations(parameters), []);
	assert.doesNotThrow(() => assertSupportedJsonSchema(parameters));
});

test('the tool output schema is a schema the registry supports', () => {
	const tool = proposeTool();
	assert.deepEqual(schemaViolations(tool.output.schema), []);
	assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema));
});

test('the tool declares everything the registry requires', () => {
	const tool = proposeTool();
	assert.equal(typeof tool.name, 'string');
	assert.equal(tool.name, TOOL_NAME);
	assert.equal(typeof tool.description, 'string');
	assert.ok(tool.description.length > 0);
	assert.equal(typeof tool.execute, 'function');
	assert.equal(typeof tool.output.render, 'function');
});

test('the tool renders text, which is what the output schema promises', () => {
	const tool = proposeTool();
	const rendered = tool.output.render({}, { ok: true, message: '计划收到了' });
	assert.ok(Array.isArray(rendered));
	assert.equal(rendered.length, 1);
	assert.equal(rendered[0].type, 'text');
	assert.equal(typeof rendered[0].text, 'string');
	assert.match(rendered[0].text, /计划收到了/);
});

test('the command definition fits the command registry', () => {
	assert.deepEqual(commandDefinitionViolations(specCommand()), []);
});

test('every result the command can return is one the registry accepts', async () => {
	const command = specCommand();
	const inputs = [
		'',
		'   ',
		'加一个多租户隔离的需求',
		'plan',
		'计划',
		'apply',
		'确认',
		'cancel',
		'取消',
		'list',
		'状态',
		'unknown-word',
	];
	for (const rawInput of inputs) {
		const withAgent = await command.handler({
			agent: { session: { id: 'session-1' } },
			rawInput,
		});
		assert.deepEqual(commandResultViolations(withAgent), [], `${JSON.stringify(rawInput)} with an agent`);

		// And the same inputs with no agent at all: the handler is reached through
		// the registry, which is the only thing that promises an agent, so a
		// missing one must come back as an error message and not a throw.
		const withoutAgent = await command.handler({ rawInput });
		assert.deepEqual(commandResultViolations(withoutAgent), [], `${JSON.stringify(rawInput)} without an agent`);
	}
});

test('the tool refuses a malformed call the same way for every bad shape', async () => {
	const tool = proposeTool();
	const agent = { session: { id: 'session-1' } };
	const calls = [
		// No agent at all, so no session to attach a plan to.
		{ args: {}, exec: {}, status: 'refused' },
		{ args: { changes: [] }, exec: { agent: {} }, status: 'refused' },
		// An agent whose session has no discussion open.
		{ args: { changes: [] }, exec: { agent }, status: 'refused' },
		{ args: { changes: 'not an array' }, exec: { agent }, status: 'refused' },
	];
	for (const call of calls) {
		const value = await tool.execute(call.args, call.exec);
		// A refusal is a rendered value, not a throw: the model has to be told what
		// went wrong, and a throw would be reported as a crashed tool call.
		assert.equal(value.status, call.status, JSON.stringify(call.args));
		assert.equal(value.accepted, 0);
		assert.equal(typeof value.message, 'string');
		assert.ok(value.message.length > 0, 'a refusal always says why');
	}
});
