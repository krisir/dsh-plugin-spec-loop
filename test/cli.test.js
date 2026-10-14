/**
 * The parts of the `openspec` CLI contract the plugin actually depends on.
 *
 * Every other test either fakes the CLI or replaces it with a stub, which is the
 * right call for testing *the plugin*. But the CLI is a separate program with its
 * own output shape, and a change to it would break the plugin without breaking a
 * single stubbed test. So this file runs the real thing, in a scratch project,
 * against the four invocations the plugin's correctness rests on: `init`,
 * `new change`, `list`, and `instructions apply`.
 *
 * The whole file skips when the CLI is not installed, the same way the render
 * tests skip without `react-dom`.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Openspec, findOpenspecRoot } from '../host/openspec.js';

/** A scratch project with the real `openspec` CLI on it. */
function scratch() {
	const dir = mkdtempSync(join(tmpdir(), 'spec-loop-cli-'));
	const project = join(dir, 'project');
	mkdirSync(project);
	const openspec = new Openspec({ projectPath: project });
	return {
		project,
		openspec,
		available: openspec.available,
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** A new harness and a cleanup that runs even when the body throws. */
function withProject(body) {
	return async () => {
		const h = scratch();
		if (!h.available) return;
		try {
			await body(h);
		} finally {
			h.cleanup();
		}
	};
}

test('a fresh project is initialized by `init`, and the root is then findable', withProject(async (h) => {
	assert.equal(h.openspec.root, undefined, 'nothing to find before init');
	const output = await h.openspec.init();
	assert.equal(typeof output, 'string');
	assert.ok(existsSync(join(h.project, 'openspec')), 'init creates openspec/');
	assert.equal(findOpenspecRoot(h.project), h.project, 'and a project root is now findable from inside it');
}));

test('`new change` creates the directory and its metadata, and `list` reports it', withProject(async (h) => {
	await h.openspec.init();
	const id = 'add-tenant-isolation';
	await h.openspec.newChange(id);

	const changeDir = join(h.project, 'openspec', 'changes', id);
	assert.ok(existsSync(changeDir), 'the change directory exists');
	assert.ok(existsSync(join(changeDir, '.openspec.yaml')), 'the CLI wrote its own metadata');

	// `list` is what the page's task tally comes from, so its shape is a contract:
	// a `changes` array whose entries carry the name and both task counts.
	const listed = await h.openspec.list();
	assert.ok(Array.isArray(listed.changes), 'list returns a changes array');
	const entry = listed.changes.find((candidate) => candidate.name === id);
	assert.ok(entry !== undefined, 'the new change is listed');
	assert.equal(entry.totalTasks, 0, 'a change with no tasks.md has no tasks');
	assert.equal(entry.completedTasks, 0);
}));

test('the task tally follows the checkboxes the plugin writes', withProject(async (h) => {
	await h.openspec.init();
	const id = 'with-tasks';
	await h.openspec.newChange(id);
	// Exactly what the plugin generates: numbered checkboxes under headings.
	writeFileSync(
		join(h.project, 'openspec', 'changes', id, 'tasks.md'),
		['## 1. 数据层', '', '- [x] 1.1 加 tenant_id 列', '- [ ] 1.2 加查询过滤', ''].join('\n'),
		'utf8',
	);

	const listed = await h.openspec.list();
	const entry = listed.changes.find((candidate) => candidate.name === id);
	assert.ok(entry !== undefined);
	assert.equal(entry.totalTasks, 2);
	assert.equal(entry.completedTasks, 1, 'the loop decides progress from this number');
}));

test('`instructions apply` reports the pending tasks in the shape the loop reads', withProject(async (h) => {
	await h.openspec.init();
	const id = 'apply-shape';
	await h.openspec.newChange(id);
	writeFileSync(
		join(h.project, 'openspec', 'changes', id, 'tasks.md'),
		['## 1. 数据层', '', '- [ ] 1.1 加列', ''].join('\n'),
		'utf8',
	);

	const info = await h.openspec.applyInfo(id);
	// The loop renders its objective from this document and gates each round on it,
	// so the fields it reads are asserted by name rather than by shape.
	assert.ok(info !== null && typeof info === 'object', 'apply info is a document');
	assert.ok(
		Object.hasOwn(info, 'tasks') || Object.hasOwn(info, 'progress') || Object.hasOwn(info, 'instruction'),
		`apply info carries tasks or progress: got ${Object.keys(info).join(', ')}`,
	);
}));

test('`validate` accepts a change whose spec delta is well formed', withProject(async (h) => {
	await h.openspec.init();
	const id = 'valid-change';
	await h.openspec.newChange(id);
	const changeDir = join(h.project, 'openspec', 'changes', id);
	mkdirSync(join(changeDir, 'specs', 'tenancy'), { recursive: true });
	writeFileSync(
		join(changeDir, 'proposal.md'),
		['## Why', '', '需要隔离。', '', '## What Changes', '', '- 加租户隔离', ''].join('\n'),
		'utf8',
	);
	writeFileSync(
		join(changeDir, 'specs', 'tenancy', 'spec.md'),
		[
			'## ADDED Requirements',
			'',
			'### Requirement: 行级过滤',
			'系统 SHALL 按 tenant_id 过滤。',
			'',
			'#### Scenario: 查询',
			'- **WHEN** 租户 A 查询',
			'- **THEN** 只看到 A 的数据',
			'',
		].join('\n'),
		'utf8',
	);

	// A rejection here is expressed as a thrown error carrying the report, which is
	// how the plugin decides whether to mark a change as needing attention.
	const report = await h.openspec.validate(id);
	assert.equal(typeof report, 'string');
}));

test('`validate` rejects a change with a spec file that has no scenarios', withProject(async (h) => {
	await h.openspec.init();
	const id = 'bad-scenarios';
	await h.openspec.newChange(id);
	const changeDir = join(h.project, 'openspec', 'changes', id);
	mkdirSync(join(changeDir, 'specs', 'tenancy'), { recursive: true });
	writeFileSync(
		join(changeDir, 'specs', 'tenancy', 'spec.md'),
		['## ADDED Requirements', '', '### Requirement: 行级过滤', '系统 SHALL 按 tenant_id 过滤。', ''].join('\n'),
		'utf8',
	);

	// This is the failure the pre-confirm lint exists to catch, so it has to be a
	// real one: if the CLI started accepting scenario-less requirements, the lint
	// would be noise and this test would be the place that says so.
	await assert.rejects(() => h.openspec.validate(id), (error) => {
		assert.match(String(error.message), /scenario|Scenario|场景/i);
		return true;
	});
}));
