import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { changeIdsOnDisk } from '../host/openspec.js';
import { lintEntry, normalizeProposal, renderProposalRules, renderTaskMarkdown, toKebab } from '../host/proposal.js';
import { describeProposal } from '../host/tool.js';
import { DRAFT_STATUS, newProposalEntry } from '../host/state.js';

const GOOD_SPEC = [
	'## Purpose',
	'',
	'这一段说明这个能力究竟为谁解决什么问题，写够五十个字才能算清楚，否则审阅的人看不出边界在哪里。',
	'',
	'## ADDED Requirements',
	'',
	'### Requirement: 用户可以看到暗色主题',
	'系统 SHALL 提供一个暗色主题，并且在重启之后记住用户的选择。',
	'',
	'#### Scenario: 用户切换主题',
	'- **WHEN** 用户点击主题切换',
	'- **THEN** 界面立即切换到暗色，并且写入本地存储',
	'',
].join('\n');

const GROUPS = [{ group: '后端', items: ['加一个开关', '写迁移'] }];

test('toKebab strips everything that cannot be an id', () => {
	assert.equal(toKebab('Add Dark Mode!'), 'add-dark-mode');
	// Latin fragments survive a Chinese title; a title with none cannot be an id.
	assert.equal(toKebab('  --糟糕的 id-- '), 'id');
	assert.equal(toKebab('全部是中文'), '');
	assert.equal(toKebab('a'.repeat(200)).length, 60);
});

test('renderTaskMarkdown numbers the tasks the loop counts', () => {
	const markdown = renderTaskMarkdown(GROUPS);
	assert.match(markdown, /^## 1\. 后端/);
	assert.match(markdown, /- \[ \] 1\.1 加一个开关/);
	assert.match(markdown, /- \[ \] 1\.2 写迁移/);
});

test('renderTaskMarkdown numbers across groups and skips empty ones', () => {
	const markdown = renderTaskMarkdown([
		{ group: 'A', items: ['一'] },
		{ group: '空的', items: ['   '] },
		{ group: 'B', items: ['二'] },
	]);
	assert.match(markdown, /^## 1\. A/);
	assert.match(markdown, /^## 2\. B/m);
	assert.match(markdown, /- \[ \] 2\.1 二/);
	assert.doesNotMatch(markdown, /空的/);
});

test('renderTaskMarkdown returns nothing usable for an empty proposal', () => {
	assert.equal(renderTaskMarkdown([]), '');
	assert.equal(renderTaskMarkdown(undefined), '');
});

test('normalizeProposal kebab-cases ids and de-duplicates against existing changes', () => {
	const { entries, dropped } = normalizeProposal(
		{
			changes: [
				{ id: 'Add Dark Mode', title: 'A', tasks: GROUPS },
				{ id: 'add-dark-mode', title: 'B', tasks: GROUPS },
				{ id: 'add_dark_mode', title: 'C', tasks: GROUPS },
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

test('normalizeProposal drops entries the loop could never finish', () => {
	const { entries, dropped } = normalizeProposal(
		{
			changes: [
				{ id: 'no tasks', title: 'Nothing to do', tasks: [] },
				{ id: 'prose tasks', title: 'Prose', tasks: 'just write some code' },
				{ id: 'good', title: 'Good', tasks: GROUPS },
			],
		},
		[],
	);
	assert.deepEqual(entries.map((entry) => entry.id), ['good']);
	assert.equal(dropped.length, 2);
	assert.match(dropped[0].reason, /复选框/);
});

test('normalizeProposal accepts a raw markdown tasks string', () => {
	const { entries } = normalizeProposal(
		{ changes: [{ id: 'pasted', title: 'Pasted', tasks: '## 1. X\n\n- [ ] 1.1 do it' }] },
		[],
	);
	assert.equal(entries.length, 1);
	assert.match(entries[0].tasks, /- \[ \] 1\.1 do it/);
});

test('normalizeProposal keeps specs and discards unusable ones', () => {
	const { entries } = normalizeProposal(
		{
			changes: [
				{
					id: 'themed',
					title: 'Themed',
					tasks: GROUPS,
					specs: [
						{ capability: 'ui/theming', content: GOOD_SPEC },
						{ capability: '', content: GOOD_SPEC },
						{ capability: 'empty', content: '   ' },
						{ capability: '/trimmed/', content: GOOD_SPEC },
					],
				},
			],
		},
		[],
	);
	assert.deepEqual(
		entries[0].specs.map((spec) => spec.capability),
		['ui/theming', 'trimmed'],
	);
});

test('lintEntry passes a well-formed change', () => {
	const { entries } = normalizeProposal(
		{ changes: [{ id: 'themed', title: 'T', tasks: GROUPS, specs: [{ capability: 'ui/theming', content: GOOD_SPEC }] }] },
		[],
	);
	assert.deepEqual(lintEntry(entries[0]), []);
});

test('lintEntry names the requirement that has no scenario', () => {
	const spec = '## ADDED Requirements\n\n### Requirement: 没有场景\n只有一句话。\n';
	const { entries } = normalizeProposal(
		{ changes: [{ id: 'themed', title: 'T', tasks: GROUPS, specs: [{ capability: 'ui/theming', content: spec }] }] },
		[],
	);
	const problems = lintEntry(entries[0]);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /没有场景/);
});

test('lintEntry tolerates a change that alters no external behaviour', () => {
	const { entries } = normalizeProposal(
		{ changes: [{ id: 'chore', title: 'Chore', tasks: GROUPS, specs: [] }] },
		[],
	);
	assert.deepEqual(lintEntry(entries[0]), []);
});

test('the artifact contract tells the agent not to write checkboxes itself', () => {
	const rules = renderProposalRules();
	assert.match(rules, /spec_loop_propose/);
	assert.match(rules, /不要自己写 `- \[ \]`/);
});

test('describeProposal summarizes a plan without its artifact bodies', () => {
	const { entries } = normalizeProposal(
		{ changes: [{ id: 'themed', title: '主题', summary: '做主题', tasks: GROUPS, specs: [{ capability: 'ui/theming', content: GOOD_SPEC }] }] },
		[],
	);
	const draft = {
		status: DRAFT_STATUS.proposed,
		proposal: { at: 123, entries: entries.map(newProposalEntry) },
		dropped: [],
	};
	const view = describeProposal(draft);
	assert.equal(view.entries.length, 1);
	assert.equal(view.entries[0].id, 'themed');
	assert.deepEqual(view.entries[0].specs, ['ui/theming']);
	assert.deepEqual(view.entries[0].tasks.map((task) => task.id), ['1.1', '1.2']);
	assert.equal(view.entries[0].include, true);
	assert.equal('proposal' in view.entries[0], false);
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
