import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { changeIdsOnDisk } from '../host/openspec.js';
import {
	CREATE_SKILL,
	ProposalError,
	Proposals,
	normalizeProposal,
	renderCreationPrompt,
	renderProposalRules,
	takenIds,
	toKebab,
} from '../host/proposal.js';
import { describeProposal } from '../host/tool.js';
import { DRAFT_STATUS, SpecLoopStore, newProposalEntry } from '../host/state.js';
import { fakeOpenspec } from './helpers.js';

test('toKebab strips everything that cannot be an id', () => {
	assert.equal(toKebab('Add Dark Mode!'), 'add-dark-mode');
	// Latin fragments survive a Chinese title; a title with none cannot be an id.
	assert.equal(toKebab('  --糟糕的 id-- '), 'id');
	assert.equal(toKebab('全部是中文'), '');
	assert.equal(toKebab('a'.repeat(200)).length, 60);
});

test('normalizeProposal kebab-cases ids and de-duplicates against existing changes', () => {
	const { entries, dropped } = normalizeProposal(
		{
			changes: [
				{ id: 'Add Dark Mode', title: 'A' },
				{ id: 'add-dark-mode', title: 'B' },
				{ id: 'add_dark_mode', title: 'C' },
			],
		},
		['add-dark-mode'],
	);
	assert.deepEqual(
		entries.map((entry) => entry.id),
		['add-dark-mode-2', 'add-dark-mode-3', 'add-dark-mode-4'],
	);
	assert.deepEqual(dropped, []);
});

test('normalizeProposal keeps only the three fields a plan has', () => {
	const { entries } = normalizeProposal(
		{
			changes: [
				{
					id: 'themed',
					title: '主题',
					summary: '  做主题  ',
					// An agent that still sends the old artifact fields is not an error;
					// they are simply not part of the plan and are dropped here.
					tasks: '- [ ] do it',
					proposal: '## Why',
					specs: [{ capability: 'ui/theming', content: 'x' }],
				},
			],
		},
		[],
	);
	assert.deepEqual(entries, [{ id: 'themed', title: '主题', summary: '做主题' }]);
	assert.deepEqual(Object.keys(entries[0]).sort(), ['id', 'summary', 'title']);
});

test('normalizeProposal drops entries the creator could not name', () => {
	const { entries, dropped } = normalizeProposal(
		{
			changes: [
				{ id: 'no-title', title: '   ' },
				{ id: '全部是中文' },
				{ id: 'good', title: '好', summary: '' },
			],
		},
		[],
	);
	assert.deepEqual(entries.map((entry) => entry.id), ['good']);
	assert.equal(dropped.length, 2);
	assert.match(dropped[0].reason, /标题/);
	assert.match(dropped[1].reason, /change id/);
});

test('the plan contract hands creation to the skill and writes nothing itself', () => {
	const rules = renderProposalRules();
	assert.match(rules, /spec_loop_propose/);
	assert.match(rules, /只提交计划/);
	assert.match(rules, /不要自己创建 `openspec\/changes\/` 目录/);
	assert.match(rules, new RegExp(CREATE_SKILL));
	// The rules must not be a template library: the skill reads the project's own
	// schema for that, and a copy here would be a second thing to keep in sync.
	assert.doesNotMatch(rules, /### Requirement:/);
});

test('the creation prompt names every id and makes them mandatory', () => {
	const prompt = renderCreationPrompt({
		projectPath: '/repo',
		entries: [
			{ id: 'tenant-tables', title: '租户表', summary: '建表' },
			{ id: 'row-filter', title: '行级过滤', summary: '' },
		],
	});
	assert.match(prompt, /openspec-propose/);
	assert.match(prompt, /\d+\. `tenant-tables` —— 租户表/);
	assert.match(prompt, /\d+\. `row-filter` —— 行级过滤/);
	assert.match(prompt, /目录名必须严格等于/);
	// The loop counts checkboxes, so the prompt has to insist on them: a change
	// created without any is a change that cannot be iterated.
	assert.match(prompt, /- \[ \]/);
	assert.match(prompt, /不要动项目代码/);
	assert.match(prompt, /\/repo/);
});

test('describeProposal summarizes a plan, which is all there is', () => {
	const { entries } = normalizeProposal({ changes: [{ id: 'themed', title: '主题', summary: '做主题' }] }, []);
	const draft = {
		status: DRAFT_STATUS.proposed,
		proposal: { at: 123, entries: entries.map(newProposalEntry) },
		dropped: [],
	};
	const view = describeProposal(draft);
	assert.equal(view.entries.length, 1);
	assert.deepEqual(view.entries[0], { id: 'themed', title: '主题', summary: '做主题', include: true });
});

test('describeProposal is empty while the discussion is still open', () => {
	assert.equal(describeProposal({ status: DRAFT_STATUS.discussing }), null);
	assert.equal(describeProposal(undefined), null);
});

test('changeIdsOnDisk counts a directory whose artifacts are still incomplete', () => {
	const root = mkdtempSync(join(tmpdir(), 'spec-loop-ids-'));
	try {
		mkdirSync(join(root, 'openspec', 'changes', 'real-change'), { recursive: true });
		writeFileSync(join(root, 'openspec', 'changes', 'real-change', 'proposal.md'), '# x\n');
		// A change being written has no artifacts yet and is still a change: the id
		// it occupies must be taken, or a new plan would collide with it.
		mkdirSync(join(root, 'openspec', 'changes', 'half-written'), { recursive: true });
		mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true });
		mkdirSync(join(root, 'openspec', 'changes', '.hidden'), { recursive: true });
		writeFileSync(join(root, 'openspec', 'changes', 'notes.md'), 'not a change\n');
		assert.deepEqual(changeIdsOnDisk(root), ['half-written', 'real-change']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * The pieces `apply` needs to be driven without a model or a real CLI.
 *
 * The session seam is stubbed because a test cannot run an agent, but the *shape*
 * of the stub is the contract: `runTurn` receives a prompt and is expected to
 * have created something by the time it resolves, exactly as the real turn does
 * when the agent follows the skill. What the plugin then does with the disk is
 * the thing under test.
 *
 * @param {object} t - the test context.
 * @param {object} [options] - knobs.
 * @param {string[]} [options.creates] - ids the stub "agent" creates. Defaults to
 *   every id named in the prompt, which is the well-behaved case.
 * @param {string} [options.tasks] - the tasks.md the stub writes.
 * @param {boolean} [options.skillMissing] - report the skill as provably absent.
 * @param {object} [options.store] - reuse a store instead of making one.
 * @returns {object} the harness.
 */
function applyHarness(t, options = {}) {
	const root = mkdtempSync(join(tmpdir(), 'spec-loop-apply-'));
	const project = join(root, 'project');
	const state = join(root, 'state');
	// `openspec/changes` alone is what marks the project as an OpenSpec root, so
	// `ensureInitialized` returns early and no `openspec init` is ever run.
	mkdirSync(join(project, 'openspec', 'changes'), { recursive: true });
	mkdirSync(state);
	const store = options.store ?? new SpecLoopStore({ file: join(state, 'state.json'), seedSettings: {} });
	store.load();
	const cli = fakeOpenspec(state);
	const prompts = [];
	const sessions = {
		skillMissing: async () => options.skillMissing === true,
		runTurn: async (request) => {
			prompts.push(request);
			const ids = options.creates ?? [...request.text.matchAll(/^\d+\. `([^`]+)`/gm)].map((match) => match[1]);
			for (const id of ids) {
				const dir = join(project, 'openspec', 'changes', id);
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, 'proposal.md'), '## Why\n\n理由。\n');
				writeFileSync(join(dir, 'tasks.md'), options.tasks ?? '- [ ] 1.1 做一件事\n');
			}
			return { result: '建好了', error: undefined };
		},
	};
	const proposals = new Proposals({ store, sessions, commandFor: () => cli, timeoutMs: 5_000 });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { project, store, sessions, prompts, proposals };
}

const PLAN = [
	{ id: 'tenant-tables', title: '租户表', summary: '建表' },
	{ id: 'row-filter', title: '行级过滤', summary: '过滤' },
];

test('apply delegates creation to the session and verifies it by id', async (t) => {
	const h = applyHarness(t);
	const outcome = await h.proposals.apply({ projectPath: h.project, entries: PLAN, maxIterations: 3, plannerSessionId: 'session-1' });

	// It asked the agent rather than writing the files itself.
	assert.equal(h.prompts.length, 1);
	assert.match(h.prompts[0].text, /openspec-propose/);
	assert.match(h.prompts[0].text, /`tenant-tables`/);

	assert.deepEqual(outcome.ids, ['tenant-tables', 'row-filter']);
	assert.deepEqual(outcome.warnings, []);
	// Registered from the disk, not from the plan.
	assert.deepEqual(h.store.changes(h.project).map((record) => record.id), ['tenant-tables', 'row-filter']);
	assert.equal(h.store.changes(h.project)[0].tasksTotal, 1);
	assert.equal(h.store.changes(h.project)[0].maxIterations, 3);
});

test('apply reports the ids the agent failed to create instead of trusting the plan', async (t) => {
	const h = applyHarness(t, { creates: ['tenant-tables'] });
	const outcome = await h.proposals.apply({ projectPath: h.project, entries: PLAN, maxIterations: 3, plannerSessionId: 'session-1' });

	assert.deepEqual(outcome.ids, ['tenant-tables']);
	assert.equal(outcome.warnings.length, 1);
	assert.match(outcome.warnings[0], /row-filter/);
	// The one that never appeared is not in the list: the page shows what exists.
	assert.deepEqual(h.store.changes(h.project).map((record) => record.id), ['tenant-tables']);
});

test('apply flags a change the agent created under a name nobody approved', async (t) => {
	// One approved id, plus one the agent invented. The invented one is on disk, so
	// staying quiet about it would leave a stray change the user never agreed to.
	const h = applyHarness(t, { creates: ['tenant-tables', 'dark-mode-support'] });
	const outcome = await h.proposals.apply({ projectPath: h.project, entries: PLAN, maxIterations: 3, plannerSessionId: 'session-1' });
	assert.deepEqual(outcome.ids, ['tenant-tables']);
	assert.equal(outcome.warnings.length, 2);
	const said = outcome.warnings.join(' ');
	assert.match(said, /row-filter/);
	assert.match(said, /dark-mode-support/);
	// Registered under the approved id only.
	assert.deepEqual(h.store.changes(h.project).map((record) => record.id), ['tenant-tables']);
});

test('apply refuses when the agent renamed instead of creating', async (t) => {
	const h = applyHarness(t, { creates: ['dark-mode-support'] });
	await assert.rejects(
		() => h.proposals.apply({ projectPath: h.project, entries: PLAN, maxIterations: 3, plannerSessionId: 'session-1' }),
		(error) => {
			assert.ok(error instanceof ProposalError);
			// It must not claim nothing happened: the directory is right there.
			assert.match(error.message, /dark-mode-support/);
			assert.deepEqual(error.detail.unexpected, ['dark-mode-support']);
			return true;
		},
	);
});

test('apply refuses when the turn created nothing at all', async (t) => {
	const h = applyHarness(t, { creates: [] });
	await assert.rejects(
		() => h.proposals.apply({ projectPath: h.project, entries: PLAN, maxIterations: 3, plannerSessionId: 'session-1' }),
		(error) => {
			assert.ok(error instanceof ProposalError);
			assert.match(error.message, /一个都没按你确认的 id 建出来/);
			assert.deepEqual(error.detail.missing, ['tenant-tables', 'row-filter']);
			return true;
		},
	);
	assert.deepEqual(h.store.changes(h.project), []);
});

test('apply refuses before spending a turn when the skill is provably absent', async (t) => {
	const h = applyHarness(t, { skillMissing: true });
	await assert.rejects(
		() => h.proposals.apply({ projectPath: h.project, entries: PLAN, maxIterations: 3, plannerSessionId: 'session-1' }),
		(error) => {
			assert.ok(error instanceof ProposalError);
			assert.match(error.message, /openspec-propose/);
			return true;
		},
	);
	// Nothing was asked of the agent, and nothing was created.
	assert.equal(h.prompts.length, 0);
	assert.deepEqual(changeIdsOnDisk(h.project), []);
});

test('apply warns about a change whose tasks the loop could not count', async (t) => {
	const h = applyHarness(t, { tasks: '## 1\n\n就写点代码\n' });
	const outcome = await h.proposals.apply({ projectPath: h.project, entries: PLAN, maxIterations: 3, plannerSessionId: 'session-1' });
	assert.equal(outcome.warnings.length, 2, 'one per change');
	assert.match(outcome.warnings[0], /复选框/);
});

test('apply refuses without a session to delegate to', async (t) => {
	const h = applyHarness(t);
	await assert.rejects(
		() => h.proposals.apply({ projectPath: h.project, entries: PLAN, maxIterations: 3 }),
		(error) => error instanceof ProposalError && /哪个会话/.test(error.message),
	);
});

test('apply refuses an empty selection without asking the agent', async (t) => {
	const h = applyHarness(t);
	await assert.rejects(() => h.proposals.apply({ projectPath: h.project, entries: [], maxIterations: 3, plannerSessionId: 'session-1' }));
	assert.equal(h.prompts.length, 0);
});

test('takenIds counts recorded changes and stray directories alike', async (t) => {
	const h = applyHarness(t);
	mkdirSync(join(h.project, 'openspec', 'changes', 'on-disk-but-unrecorded'), { recursive: true });
	h.store.mutate(() => h.store.ensure(h.project, 'recorded', { title: 'x' }));
	assert.deepEqual(takenIds(h.store, h.project).sort(), ['on-disk-but-unrecorded', 'recorded']);
});
