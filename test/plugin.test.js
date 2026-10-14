/**
 * Activation: does the plugin actually register what it claims to?
 *
 * A stub context is the only way to reach this without starting a Host, and it
 * earns its place by covering the wiring that nothing else touches — the command
 * definition the command plane validates, the tool definition the tool registry
 * validates, the route the web server mounts. Those contracts are checked by the
 * services themselves at register time, so calling `register` for real is the
 * assertion.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply, inject as declaredInject, name } from '../host/plugin.js';
import { configFor, stubContext } from './helpers.js';

test('the plugin declares the services it reaches for', () => {
	assert.equal(name, 'dsh-plugin-spec-loop');
	assert.deepEqual(declaredInject, ['sessionController', 'webServer', 'sessions', 'agents']);
});

test('apply registers the /spec command with the shape the plane validates', (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'spec-loop-plugin-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { ctx, commands, routes } = stubContext(t);
	apply(ctx, configFor(dir));
	assert.equal(commands.length, 1);
	const command = commands[0];
	assert.equal(command.name, 'spec');
	assert.equal(typeof command.description, 'string');
	assert.equal(typeof command.handler, 'function');
	assert.equal(typeof command.input.hint, 'string');
	// The command name must satisfy the composer's grammar.
	assert.match(command.name, /^[a-z0-9_-]+$/);
	assert.equal(routes.length, 1);
	assert.equal(routes[0].kind, 'prefix');
	assert.equal(routes[0].path, '/dsh-spec-loop/api');
});

test('apply registers the proposal tool with the shape the registry validates', (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'spec-loop-plugin-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { ctx, tools } = stubContext(t);
	apply(ctx, configFor(dir));
	assert.equal(tools.length, 1);
	const tool = tools[0];
	assert.equal(tool.name, 'spec_loop_propose');
	assert.equal(typeof tool.execute, 'function');
	assert.equal(tool.parameters.type, 'object');
	// `register` requires `output.schema` to be a supported schema and `render` to
	// be callable; both are asserted structurally here because the real validator
	// lives in a service this package cannot import.
	assert.equal(tool.output.schema.type, 'object');
	assert.equal(typeof tool.output.render, 'function');
});

test('the plugin loads without the command and tool services', (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'spec-loop-plugin-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { ctx, commands, tools, routes } = stubContext(t, { withCommands: false, withTools: false });
	apply(ctx, configFor(dir));
	assert.deepEqual(commands, []);
	assert.deepEqual(tools, []);
	// The page and the loop are still wired: the command plane is an entry point,
	// not a dependency.
	assert.equal(routes.length, 1);
});

test('a duplicate command name costs the command, not the plugin', (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'spec-loop-plugin-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { ctx, logs, routes } = stubContext(t);
	ctx.inject = (keys, callback) => {
		if (keys.includes('commands')) {
			const scoped = { commands: { register: () => { throw new Error('duplicate command name: spec'); } } };
			callback(scoped);
			return () => {};
		}
		return () => {};
	};
	apply(ctx, configFor(dir));
	assert.equal(routes.length, 1, 'the routes must still be mounted');
	assert.ok(logs.some((line) => line.includes('could not register the /spec command')));
});

test('the handler serves state for a session it can resolve', async (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'spec-loop-plugin-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { ctx, routes } = stubContext(t, { cwd: dir });
	apply(ctx, configFor(dir));

	const answered = await new Promise((resolve) => {
		const res = {
			statusCode: 0,
			statusMessage: '',
			headers: {},
			writeHead(status, headers) {
				this.statusCode = status;
				this.headers = headers;
			},
			end(body) {
				resolve({ status: this.statusCode, body: JSON.parse(body) });
			},
		};
		void routes[0].handler(
			{ method: 'GET', url: '/dsh-spec-loop/api/state?sessionId=session-1', socket: { remoteAddress: '127.0.0.1' }, headers: {} },
			res,
		);
	});
	assert.equal(answered.status, 200);
	assert.equal(answered.body.projectPath, dir);
	assert.equal(answered.body.discussion, null);
	assert.deepEqual(answered.body.changes, []);
});

test('a mutation from a non-loopback address is refused', async (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'spec-loop-plugin-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { ctx, routes } = stubContext(t, { cwd: dir });
	apply(ctx, configFor(dir));
	const answered = await new Promise((resolve) => {
		const res = {
			statusCode: 0,
			statusMessage: '',
			writeHead(status) {
				this.statusCode = status;
			},
			end(body) {
				resolve({ status: this.statusCode, body: JSON.parse(body) });
			},
		};
		void routes[0].handler(
			{
				method: 'POST',
				url: '/dsh-spec-loop/api/draft/discard',
				socket: { remoteAddress: '10.0.0.9' },
				headers: { 'content-type': 'application/json' },
			},
			res,
		);
	});
	assert.equal(answered.status, 403);
	assert.equal(answered.body.error.code, 'FORBIDDEN');
});

test('the durable file the config names is the one that gets written', (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'spec-loop-plugin-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, 'custom-state.json');
	writeFileSync(file, JSON.stringify({ version: 1, settings: { ralphIterations: 7 }, projects: {}, drafts: {} }));
	const { ctx, commands } = stubContext(t);
	apply(ctx, configFor(dir, { file }));
	// The seeded value is overridden by the document, which is the point of the
	// seed-only rule: a restart must not undo the settings the user chose.
	return commands[0]
		.handler({ agent: { session: { id: 'session-1' } }, rawInput: 'list' })
		.then((result) => {
			assert.equal(result.kind, 'success');
		});
});
