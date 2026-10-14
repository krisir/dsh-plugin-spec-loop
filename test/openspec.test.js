import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Openspec, changeIdsOnDisk, findOpenspecRoot, readProposalSummary, readTasks, resolveExecutable } from '../host/openspec.js';

/** A scratch project with an openspec root. */
function scratch() {
	const dir = mkdtempSync(join(tmpdir(), 'spec-loop-'));
	mkdirSync(join(dir, 'openspec', 'changes', 'existing-change'), { recursive: true });
	writeFileSync(join(dir, 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');
	return dir;
}

test('findOpenspecRoot walks up to the project root', () => {
	const dir = scratch();
	try {
		mkdirSync(join(dir, 'src', 'deep', 'nested'), { recursive: true });
		assert.equal(findOpenspecRoot(join(dir, 'src', 'deep', 'nested')), dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('findOpenspecRoot returns undefined outside a project', () => {
	const dir = mkdtempSync(join(tmpdir(), 'spec-loop-'));
	try {
		assert.equal(findOpenspecRoot(dir), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('changeIdsOnDisk lists real changes and skips archive', () => {
	const dir = scratch();
	try {
		mkdirSync(join(dir, 'openspec', 'changes', 'archive'), { recursive: true });
		mkdirSync(join(dir, 'openspec', 'changes', 'second-change'), { recursive: true });
		mkdirSync(join(dir, 'openspec', 'changes', '.hidden'), { recursive: true });
		assert.deepEqual(changeIdsOnDisk(dir), ['existing-change', 'second-change']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('readTasks counts checkboxes and returns the pending descriptions', () => {
	const dir = scratch();
	try {
		const changeDir = join(dir, 'openspec', 'changes', 'existing-change');
		writeFileSync(
			join(changeDir, 'tasks.md'),
			['## 1. Setup', '', '- [ ] 1.1 First', '- [x] 1.2 Second', '- [ ] 1.3 Third', 'not a task'].join('\n'),
			'utf8',
		);
		assert.deepEqual(readTasks(changeDir), {
			total: 3,
			done: 1,
			pending: ['1.1 First', '1.3 Third'],
			// The ids are split off the descriptions because the objective the loop
			// writes keeps them, and the page shows task ids in the plan review.
			items: [
				{ id: '1.1', description: 'First' },
				{ id: '1.2', description: 'Second' },
				{ id: '1.3', description: 'Third' },
			],
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('readTasks tolerates a missing tasks.md', () => {
	const dir = scratch();
	try {
		assert.deepEqual(readTasks(join(dir, 'openspec', 'changes', 'existing-change')), {
			total: 0,
			done: 0,
			pending: [],
			items: [],
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('readProposalSummary takes the heading and the first paragraph', () => {
	const dir = scratch();
	try {
		const changeDir = join(dir, 'openspec', 'changes', 'existing-change');
		writeFileSync(
			join(changeDir, 'proposal.md'),
			['# 多租户隔离', '', '给系统加上行级租户隔离。', '', '## Why', '', '更多细节。'].join('\n'),
			'utf8',
		);
		assert.deepEqual(readProposalSummary(changeDir), {
			title: '多租户隔离',
			summary: '给系统加上行级租户隔离。',
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('resolveExecutable finds a bare name on PATH and rejects a missing one', () => {
	assert.equal(resolveExecutable('definitely-not-a-real-binary-xyz'), undefined);
	const found = resolveExecutable('sh');
	assert.ok(found === undefined || found.endsWith('/sh'));
});

test('Openspec reports the project root and change directory', () => {
	const dir = scratch();
	try {
		const openspec = new Openspec({ projectPath: join(dir, 'src'), command: 'definitely-not-a-real-binary-xyz' });
		assert.equal(openspec.root, dir);
		assert.equal(openspec.changeDir('existing-change'), join(dir, 'openspec', 'changes', 'existing-change'));
		assert.equal(openspec.available, false);
		assert.equal(openspec.describe().initialized, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('Openspec.run rejects with a readable error when the command is missing', async () => {
	const dir = scratch();
	try {
		const openspec = new Openspec({ projectPath: dir, command: 'definitely-not-a-real-binary-xyz' });
		await assert.rejects(() => openspec.run(['list']), /找不到 openspec 命令/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
