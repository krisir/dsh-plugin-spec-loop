import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	parseSpecCommand,
	renderChangeList,
	renderKickoffPrompt,
	renderPlanNudge,
	renderStatus,
} from '../host/discourse.js';
import { DRAFT_STATUS, newProposalEntry } from '../host/state.js';
import { createProposeTool, TOOL_NAME } from '../host/tool.js';
import { SpecLoopStore } from '../host/state.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A store in a scratch directory that is removed afterwards. */
function scratchStore(t) {
	const dir = mkdtempSync(join(tmpdir(), 'spec-loop-discourse-'));
	const store = new SpecLoopStore({ file: join(dir, 'state.json'), seedSettings: {} });
	store.load();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return store;
}

test('an empty input is the status action', () => {
	assert.deepEqual(parseSpecCommand(''), { kind: 'status' });
	assert.deepEqual(parseSpecCommand('   '), { kind: 'status' });
	assert.deepEqual(parseSpecCommand(undefined), { kind: 'status' });
});

test('a bare control word is a control action, in either language', () => {
	assert.equal(parseSpecCommand('plan').kind, 'plan');
	assert.equal(parseSpecCommand('计划').kind, 'plan');
	assert.equal(parseSpecCommand('Apply').kind, 'apply');
	assert.equal(parseSpecCommand('确认').kind, 'apply');
	assert.equal(parseSpecCommand('cancel').kind, 'cancel');
	assert.equal(parseSpecCommand('取消').kind, 'cancel');
	assert.equal(parseSpecCommand('list').kind, 'list');
	assert.equal(parseSpecCommand('状态').kind, 'status');
});

test('a control word inside a requirement is part of the requirement', () => {
	const parsed = parseSpecCommand('帮我修一下 plan 的解析');
	assert.equal(parsed.kind, 'start');
	assert.equal(parsed.requirement, '帮我修一下 plan 的解析');
});

test('a multi-line requirement is kept whole', () => {
	const parsed = parseSpecCommand('第一行\n\n第二行');
	assert.equal(parsed.kind, 'start');
	assert.match(parsed.requirement, /第一行\n\n第二行/);
});

test('the kickoff prompt forbids creating changes and asks for questions', () => {
	const prompt = renderKickoffPrompt({
		requirement: '加多租户',
		projectPath: '/repo',
		openspecRoot: '/repo',
		existingIds: ['add-dark-mode'],
	});
	assert.match(prompt, /加多租户/);
	assert.match(prompt, /add-dark-mode/);
	assert.match(prompt, /不要创建任何 change/);
	assert.match(prompt, /一次只问最关键的 2～4 个问题/);
	assert.match(prompt, /spec_loop_propose/);
});

test('the kickoff prompt says so when there is nothing on disk yet', () => {
	const prompt = renderKickoffPrompt({ requirement: 'x', projectPath: '/r', openspecRoot: '/r', existingIds: [] });
	assert.match(prompt, /还没有任何 change/);
});

test('the plan nudge is short and repeats the no-write rule', () => {
	const prompt = renderPlanNudge({ requirement: '加多租户' });
	assert.ok(prompt.includes('加多租户'));
	assert.match(prompt, /spec_loop_propose/);
	assert.match(prompt, /不要创建任何/);
});

test('status text explains the next step in each state', () => {
	const empty = renderStatus({ draft: undefined, projectPath: '/r', changeCount: 2 });
	assert.match(empty, /还没有讨论中的需求/);
	assert.match(empty, /2 个 change/);

	const discussing = renderStatus({
		draft: { status: DRAFT_STATUS.discussing, requirement: '加多租户' },
		projectPath: '/r',
		changeCount: 0,
	});
	assert.match(discussing, /加多租户/);
	assert.match(discussing, /\/spec plan/);

	const proposed = renderStatus({
		draft: {
			status: DRAFT_STATUS.proposed,
			requirement: '加多租户',
			proposal: {
				entries: [
					newProposalEntry({ id: 'a', title: 'A', summary: '' }),
					{ ...newProposalEntry({ id: 'b', title: 'B', summary: '' }), include: false },
				],
			},
		},
		projectPath: '/r',
		changeCount: 0,
	});
	assert.match(proposed, /\[x\] a — A/);
	assert.match(proposed, /\[ \] b — B/);
	assert.match(proposed, /已勾选 1 个/);
});

test('status warns when the session has no project', () => {
	const text = renderStatus({ draft: undefined, projectPath: undefined, changeCount: 0 });
	assert.match(text, /没有工作目录/);
});

test('the change list reports progress and rounds, or says it is empty', () => {
	assert.match(renderChangeList([]), /还没有任何 change/);
	const text = renderChangeList([
		{ id: 'a', title: 'A', status: 'running', tasksDone: 2, tasksTotal: 5, iterations: 1, maxIterations: 3 },
	]);
	assert.match(text, /a \[running\] 2\/5 轮次 1\/3 — A/);
});

test('the propose tool stores a plan without creating anything', (t) => {
	const store = scratchStore(t);
	store.saveDraft({
		sessionId: 'session-1',
		projectPath: '/repo',
		requirement: '加多租户',
		status: DRAFT_STATUS.discussing,
		createdAt: 1,
		updatedAt: 1,
		dropped: [],
	});
	const tool = createProposeTool({ store, projectOfSession: () => '/repo' });
	const value = tool.execute(
		{ changes: [{ id: 'multi-tenant', title: '多租户', summary: '做隔离' }] },
		{ agent: { session: { id: 'session-1' } } },
	);
	assert.equal(value.status, 'accepted');
	assert.equal(value.accepted, 1);
	assert.match(value.message, /现在什么都还没有创建/);
	const draft = store.draft('session-1');
	assert.equal(draft.status, DRAFT_STATUS.proposed);
	assert.equal(draft.proposal.entries.length, 1);
	assert.equal(draft.proposal.entries[0].include, true);
});

test('the propose tool refuses a call with no discussion behind it', (t) => {
	const store = scratchStore(t);
	const tool = createProposeTool({ store, projectOfSession: () => '/repo' });
	const value = tool.execute({ changes: [{ id: 'x', title: 'X' }] }, { agent: { session: { id: 'session-9' } } });
	assert.equal(value.status, 'refused');
	assert.match(value.message, /\/spec <需求>/);
	assert.equal(store.draft('session-9'), undefined);
});

test('the propose tool reports what it dropped instead of failing silently', (t) => {
	const store = scratchStore(t);
	store.saveDraft({
		sessionId: 'session-2',
		projectPath: '/repo',
		requirement: 'x',
		status: DRAFT_STATUS.discussing,
		createdAt: 1,
		updatedAt: 1,
		dropped: [],
	});
	const tool = createProposeTool({ store, projectOfSession: () => '/repo' });
	// An entry with no title is one the creator could not name, so it is dropped
	// rather than saved as a change the user would see as a bare id.
	const value = tool.execute({ changes: [{ id: 'no-title', title: '   ' }] }, { agent: { session: { id: 'session-2' } } });
	assert.equal(value.status, 'rejected');
	assert.match(value.message, /没有被保存/);
	assert.match(value.message, /标题/);
	assert.equal(value.dropped, 1);
	assert.equal(store.draft('session-2').status, DRAFT_STATUS.discussing);
});

test('the propose tool replaces an earlier plan, which is how a revision works', (t) => {
	const store = scratchStore(t);
	store.saveDraft({
		sessionId: 'session-3',
		projectPath: '/repo',
		requirement: 'x',
		status: DRAFT_STATUS.discussing,
		createdAt: 1,
		updatedAt: 1,
		dropped: [],
	});
	const tool = createProposeTool({ store, projectOfSession: () => '/repo' });
	const exec = { agent: { session: { id: 'session-3' } } };
	tool.execute({ changes: [{ id: 'first', title: 'First' }] }, exec);
	tool.execute({ changes: [{ id: 'second', title: 'Second' }] }, exec);
	const entries = store.draft('session-3').proposal.entries;
	assert.deepEqual(entries.map((entry) => entry.id), ['second']);
});

test('the propose tool stores a plan and defers creation to the skill', (t) => {
	const store = scratchStore(t);
	store.saveDraft({
		sessionId: 'session-4',
		projectPath: '/repo',
		requirement: 'x',
		status: DRAFT_STATUS.discussing,
		createdAt: 1,
		updatedAt: 1,
		dropped: [],
	});
	const tool = createProposeTool({ store, projectOfSession: () => '/repo' });
	const value = tool.execute(
		{
			changes: [
				{
					id: 'themed',
					title: 'T',
					summary: '做主题',
					// An agent still sending the old artifact fields is not an error —
					// they are simply not part of a plan and must not be stored.
					tasks: [{ group: 'A', items: ['一'] }],
					specs: [{ capability: 'ui/theming', content: '### Requirement: 没有场景\n' }],
				},
			],
		},
		{ agent: { session: { id: 'session-4' } } },
	);
	assert.equal(value.status, 'accepted');
	assert.deepEqual(Object.keys(store.draft('session-4').proposal.entries[0]).sort(), ['id', 'include', 'summary', 'title']);
	// The tool must tell the agent, in the response it reads, to stop and wait.
	assert.match(value.message, /不要创建任何目录或文件/);
	assert.match(value.message, /openspec-propose/);
	assert.match(value.message, /等用户/);
});

test('the propose tool refuses when the session cannot be resolved', (t) => {
	const store = scratchStore(t);
	const tool = createProposeTool({ store, projectOfSession: () => '/repo' });
	const value = tool.execute({ changes: [] }, {});
	assert.equal(value.status, 'refused');
	assert.match(value.message, /哪个会话/);
});

test('the tool definition is shaped the way the registry validates it', () => {
	const tool = createProposeTool({ store: null, projectOfSession: () => undefined });
	assert.equal(tool.name, TOOL_NAME);
	assert.equal(typeof tool.description, 'string');
	assert.equal(tool.parameters.type, 'object');
	assert.deepEqual(tool.parameters.required, ['changes']);
	assert.equal(tool.parameters.additionalProperties, false);
	assert.equal(tool.output.schema.type, 'object');
	assert.equal(typeof tool.output.render, 'function');
	assert.deepEqual(tool.output.render({}, { message: 'hi' }), [{ type: 'text', text: 'hi' }]);
	assert.equal(typeof tool.execute, 'function');
});
