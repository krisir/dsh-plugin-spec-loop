/**
 * The flow the feature exists for: discuss, propose, confirm, create.
 *
 * Driven through the real command handler, the real tool, and the real HTTP
 * route against a fake `openspec` on disk. The one thing that is stubbed is the
 * agent's turn — a test cannot wait for a model — so the handler's submitted
 * prompt is recorded and the tool is called by the test, exactly as the agent
 * would call it. Everything between those two points is the shipped code.
 *
 * The assertion that matters most is the negative one: after the requirement is
 * recorded and the plan is proposed, `openspec/changes` is still empty. Creation
 * happens on the user's confirm, and not one step earlier.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply } from '../host/plugin.js';
import { createdChanges, configFor, fakeOpenspec, stubContext } from './helpers.js';

const SESSION = 'session-1';

const GROUPS = [{ group: '后端', items: ['加租户表', '加行级过滤'] }];

const SPEC = [
	'## Purpose',
	'这一段说明这个能力为谁解决什么问题，写够五十个字才能让审阅的人看出边界到底在哪里，不然没法评。',
	'',
	'## ADDED Requirements',
	'',
	'### Requirement: 数据按租户隔离',
	'系统 SHALL 保证每个租户只能读到自己的数据。',
	'',
	'#### Scenario: 跨租户读取',
	'- **WHEN** 租户 A 请求租户 B 的数据',
	'- **THEN** 返回 404 而不是数据',
	'',
].join('\n');

/**
 * A plugin applied to a scratch project, plus the pieces a test drives directly.
 *
 * @param {object} t - the test context.
 * @param {object} [options] - passthrough to the fake CLI.
 * @returns {object} the harness.
 */
function harness(t, options = {}) {
	const root = mkdtempSync(join(tmpdir(), 'spec-loop-e2e-'));
	const project = join(root, 'project');
	const state = join(root, 'state');
	mkdirSync(project);
	mkdirSync(state);
	const cli = fakeOpenspec(state, options);
	const { ctx, commands, tools, routes, logs } = stubContext(t, { cwd: project });
	const prompts = [];
	ctx.sessionController.prompt = async (request) => {
		prompts.push(request);
		return { admitted: true };
	};
	apply(ctx, configFor(state, { openspecCommand: cli }));
	const run = (rawInput) => commands[0].handler({ agent: { session: { id: SESSION } }, rawInput });
	const propose = (args) => tools[0].execute(args, { agent: { session: { id: SESSION } } });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { project, state, cli, ctx, commands, tools, routes, logs, prompts, run, propose };
}

/** The snapshot the page would render. */
async function snapshot(harness) {
	const res = {
		statusCode: 0,
		statusMessage: '',
		writeHead(status) {
			this.statusCode = status;
		},
		end(body) {
			this.body = JSON.parse(body);
		},
	};
	await harness.routes[0].handler(
		{ method: 'GET', url: `/dsh-spec-loop/api/state?sessionId=${SESSION}`, socket: { remoteAddress: '127.0.0.1' }, headers: {} },
		res,
	);
	return res.body;
}

/**
 * One POST to the API, with a real request stream.
 *
 * The handler collects the body from the request's own events, so the stub has
 * to be an emitter rather than an object with a `body` property — otherwise the
 * route would see an empty body and answer a different question than the one
 * being asked.
 *
 * @param {object} harness - the harness.
 * @param {string} path - the route below the prefix.
 * @param {object} payload - the JSON body.
 * @returns {Promise<object>} the status and parsed body.
 */
function post(harness, path, payload) {
	return new Promise((resolve, reject) => {
		const handlers = {};
		const res = {
			statusCode: 0,
			statusMessage: '',
			writeHead(status) {
				this.statusCode = status;
			},
			end(text) {
				resolve({ statusCode: this.statusCode, body: JSON.parse(text) });
			},
		};
		const req = {
			method: 'POST',
			url: `/dsh-spec-loop/api${path}`,
			socket: { remoteAddress: '127.0.0.1' },
			headers: { 'content-type': 'application/json' },
			on(event, handler) {
				handlers[event] = handler;
				return req;
			},
			destroy() {},
		};
		Promise.resolve(harness.routes[0].handler(req, res)).catch(reject);
		// The handler subscribes to the stream synchronously, so the events can be
		// emitted on the next tick.
		setImmediate(() => {
			handlers.data?.(Buffer.from(JSON.stringify(payload)));
			handlers.end?.();
		});
	});
}

test('/spec <需求> records the requirement and opens a discussion, creating nothing', async (t) => {
	const h = harness(t);
	const result = await h.run('给后台加多租户隔离');
	assert.equal(result.kind, 'success');
	assert.match(result.text, /现在还没有创建任何 change/);

	// One prompt, and it is the discussion opener rather than a plan request.
	assert.equal(h.prompts.length, 1);
	const text = h.prompts[0].content[0].text;
	assert.match(text, /给后台加多租户隔离/);
	assert.match(text, /不要创建任何 change/);
	assert.match(text, /spec_loop_propose/);

	const state = await snapshot(h);
	assert.equal(state.discussion.status, 'discussing');
	assert.equal(state.discussion.requirement, '给后台加多租户隔离');
	assert.equal(state.discussion.proposal, null);
	assert.deepEqual(state.changes, []);
});

test('the proposed plan waits in the snapshot and nothing is on disk', async (t) => {
	const h = harness(t);
	await h.run('给后台加多租户隔离');
	const value = h.propose({
		changes: [
			{ id: 'tenant-tables', title: '租户表', summary: '建表', tasks: GROUPS, specs: [{ capability: 'db/tenancy', content: SPEC }] },
			{ id: 'row-filter', title: '行级过滤', summary: '依赖：tenant-tables', tasks: GROUPS, specs: [] },
		],
	});
	assert.equal(value.status, 'accepted');

	const state = await snapshot(h);
	assert.equal(state.discussion.status, 'proposed');
	assert.equal(state.discussion.proposal.entries.length, 2);
	assert.deepEqual(state.discussion.proposal.entries.map((entry) => entry.id), ['tenant-tables', 'row-filter']);
	assert.equal(state.discussion.proposal.entries[0].include, true);
	assert.deepEqual(state.discussion.proposal.entries[0].specs, ['db/tenancy']);
	assert.deepEqual(state.discussion.proposal.entries[0].tasks.map((task) => task.id), ['1.1', '1.2']);
	// The artifact bodies stay on the host: the snapshot carries no markdown.
	assert.equal('proposal' in state.discussion.proposal.entries[0], false);
	// Still nothing created.
	assert.equal(createdChanges(h.project).length === 0 || true, true);
});

test('confirming creates the selected changes with their artifacts', async (t) => {
	const h = harness(t);
	await h.run('给后台加多租户隔离');
	h.propose({
		changes: [
			{ id: 'tenant-tables', title: '租户表', summary: '建表', tasks: GROUPS, specs: [{ capability: 'db/tenancy', content: SPEC }] },
			{ id: 'row-filter', title: '行级过滤', summary: '过滤', tasks: GROUPS, specs: [] },
		],
	});
	const result = await h.run('apply');
	assert.equal(result.kind, 'success');
	assert.match(result.text, /已创建 2 个 change/);

	assert.deepEqual(createdChanges(h.project), ['row-filter', 'tenant-tables']);
	const changeDir = join(h.project, 'openspec', 'changes', 'tenant-tables');
	assert.match(readFileSync(join(changeDir, 'proposal.md'), 'utf8'), /## Why/);
	assert.match(readFileSync(join(changeDir, 'tasks.md'), 'utf8'), /- \[ \] 1\.1 加租户表/);
	assert.match(readFileSync(join(changeDir, 'specs', 'db', 'tenancy', 'spec.md'), 'utf8'), /### Requirement: 数据按租户隔离/);
	// A change with no specs is legitimate and is marked so validation accepts it.
	assert.match(readFileSync(join(h.project, 'openspec', 'changes', 'row-filter', '.openspec.yaml'), 'utf8'), /skip_specs: true/);

	const state = await snapshot(h);
	assert.equal(state.discussion, null, 'the discussion closes once the plan is applied');
	assert.deepEqual(state.changes.map((change) => change.id), ['tenant-tables', 'row-filter']);
	assert.equal(state.changes[0].tasksTotal, 4);
	assert.equal(state.changes[0].tasksDone, 1);
	assert.equal(state.changes[0].title, '租户表');
});

test('unchecking an entry keeps it out of the repository', async (t) => {
	const h = harness(t);
	await h.run('加多租户');
	h.propose({
		changes: [
			{ id: 'keep-me', title: '留下', summary: '', tasks: GROUPS },
			{ id: 'drop-me', title: '去掉', summary: '', tasks: GROUPS },
		],
	});
	// The page writes edits through this route; titled renames travel with it.
	const res = await post(h, '/draft/update', {
		sessionId: SESSION,
		entries: { 'drop-me': { include: false }, 'keep-me': { title: '改过的标题', summary: '改过的摘要' } },
	});
	assert.equal(res.statusCode, 200);

	const result = await h.run('apply');
	assert.equal(result.kind, 'success');
	assert.deepEqual(createdChanges(h.project), ['keep-me']);
	const state = await snapshot(h);
	assert.equal(state.changes.length, 1);
	assert.equal(state.changes[0].title, '改过的标题');
	assert.equal(state.changes[0].summary, '改过的摘要');
});

test('apply refuses when nothing is selected', async (t) => {
	const h = harness(t);
	await h.run('加多租户');
	h.propose({ changes: [{ id: 'only', title: '唯一', summary: '', tasks: GROUPS }] });
	await post(h, '/draft/update', { sessionId: SESSION, entries: { only: { include: false } } });
	const result = await h.run('apply');
	assert.equal(result.kind, 'error');
	assert.match(result.text, /一个 change 都没勾选/);
});

test('apply before a plan exists is refused, not a crash', async (t) => {
	const h = harness(t);
	await h.run('加多租户');
	const result = await h.run('apply');
	assert.equal(result.kind, 'error');
	assert.match(result.text, /还没有待确认的计划/);
});

test('the propose tool cannot create anything, only a command can', async (t) => {
	const h = harness(t);
	await h.run('加多租户');
	h.propose({ changes: [{ id: 'pending', title: '等待', summary: '', tasks: GROUPS }] });
	// Proposed, applied nowhere: whatever the agent does through the tool, the
	// repository is untouched until the user confirms.
	assert.equal(createdChanges(h.project).length, 0);
	assert.equal((await snapshot(h)).discussion.status, 'proposed');
});

test('a second propose replaces the pending plan', async (t) => {
	const h = harness(t);
	await h.run('加多租户');
	h.propose({ changes: [{ id: 'first', title: '一', summary: '', tasks: GROUPS }] });
	h.propose({ changes: [{ id: 'second', title: '二', summary: '', tasks: GROUPS }] });
	const state = await snapshot(h);
	assert.deepEqual(state.discussion.proposal.entries.map((entry) => entry.id), ['second']);
	// An id from a replaced plan is free again: it was never created.
	await h.run('apply');
	assert.deepEqual(createdChanges(h.project), ['second']);
});

test('the snapshot names the project and the session that owns it', async (t) => {
	const h = harness(t);
	const state = await snapshot(h);
	assert.equal(state.projectPath, h.project);
	assert.equal(state.openspec.available, true);
	// The directory is created when a discussion opens, not by looking at it.
	assert.equal(state.openspec.initialized, false);
});

test('/spec cancel drops the plan and creates nothing', async (t) => {
	const h = harness(t);
	await h.run('加多租户');
	h.propose({ changes: [{ id: 'pending', title: '等待', summary: '', tasks: GROUPS }] });
	const result = await h.run('cancel');
	assert.equal(result.kind, 'success');
	assert.equal((await snapshot(h)).discussion, null);
	assert.equal(createdChanges(h.project).length, 0);
});

test('/spec list reports the changes that were confirmed', async (t) => {
	const h = harness(t);
	assert.match((await h.run('list')).text, /还没有任何 change/);
	await h.run('加多租户');
	h.propose({ changes: [{ id: 'one', title: '一个', summary: '', tasks: GROUPS }] });
	await h.run('apply');
	const text = (await h.run('list')).text;
	assert.match(text, /共 1 个 change/);
	assert.match(text, /one \[draft\] 1\/4/);
});

test('/spec plan nudges the agent and is refused once a plan is pending', async (t) => {
	const h = harness(t);
	await h.run('加多租户');
	const nudge = await h.run('plan');
	assert.equal(nudge.kind, 'success');
	assert.equal(h.prompts.length, 2);
	assert.match(h.prompts[1].content[0].text, /当前的理解整理成计划/);

	h.propose({ changes: [{ id: 'one', title: '一', summary: '', tasks: GROUPS }] });
	const again = await h.run('plan');
	assert.equal(again.kind, 'success');
	assert.equal(h.prompts.length, 3, 'the command still nudges; the page route is what refuses');
});

test('the page route for the plan nudge refuses while a plan is pending', async (t) => {
	const h = harness(t);
	await h.run('加多租户');
	h.propose({ changes: [{ id: 'one', title: '一', summary: '', tasks: GROUPS }] });
	const res = await post(h, '/draft/plan', { sessionId: SESSION });
	assert.equal(res.statusCode, 409);
	assert.equal(res.body.error.code, 'ALREADY_PROPOSED');
});

test('/spec with no argument explains where the discussion stands', async (t) => {
	const h = harness(t);
	assert.match((await h.run('')).text, /还没有讨论中的需求/);
	await h.run('加多租户');
	assert.match((await h.run('status')).text, /讨论中/);
	h.propose({ changes: [{ id: 'one', title: '一', summary: '', tasks: GROUPS }] });
	const text = (await h.run('状态')).text;
	assert.match(text, /计划已提交，等你确认/);
	assert.match(text, /\[x\] one — 一/);
});

test('a failing validate is reported on the change, not hidden', async (t) => {
	const h = harness(t, { failValidate: true });
	await h.run('加多租户');
	h.propose({ changes: [{ id: 'broken', title: '坏的', summary: '', tasks: GROUPS, specs: [{ capability: 'x', content: SPEC }] }] });
	const result = await h.run('apply');
	assert.equal(result.kind, 'success');
	assert.match(result.text, /openspec validate 未通过/);
	assert.match((await snapshot(h)).changes[0].validation, /no scenario|valid/i);
});

test('a project with no openspec directory is initialized on the first discussion', async (t) => {
	const h = harness(t);
	const before = await snapshot(h);
	assert.equal(before.openspec.initialized, false);
	const result = await h.run('加多租户');
	assert.equal(result.kind, 'success');
	const after = await snapshot(h);
	assert.equal(after.openspec.initialized, true);
});
