import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CHANGE_STATUS, SpecLoopStore, defaultFilePath, normalizeSettings } from '../host/state.js';

/** A store backed by a scratch file. */
function scratchStore(seed = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'spec-loop-'));
	const file = join(dir, 'state.json');
	return { dir, file, store: new SpecLoopStore({ file, seedSettings: seed }) };
}

test('normalizeSettings clamps every numeric field and fills the defaults', () => {
	const settings = normalizeSettings({
		ralphIterations: 999,
		concurrency: 0,
		iterationTimeoutMinutes: -3,
		stallLimit: 100,
		autoApprove: 'yes',
		openspecCommand: '   ',
	});
	assert.equal(settings.ralphIterations, 50);
	assert.equal(settings.concurrency, 1);
	assert.equal(settings.iterationTimeoutMinutes, 1);
	assert.equal(settings.stallLimit, 20);
	assert.equal(settings.autoApprove, true, 'a non-boolean falls back to the default, which is true');
	assert.equal(settings.openspecCommand, 'openspec');
});

test('normalizeSettings accepts junk without throwing', () => {
	assert.equal(normalizeSettings(null).ralphIterations, 3);
	assert.equal(normalizeSettings('nope').concurrency, 1);
	assert.equal(normalizeSettings({ ralphIterations: 'abc' }).ralphIterations, 3);
	assert.equal(normalizeSettings({ concurrency: '4' }).concurrency, 4);
});

test('defaultFilePath lives under DSH_HOME', () => {
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = '/tmp/dsh-home-probe';
	try {
		assert.equal(defaultFilePath(), '/tmp/dsh-home-probe/spec-loop/state.json');
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
});

test('a new store starts empty and seeds its settings from the composition config', () => {
	const { dir, store } = scratchStore({ ralphIterations: 7, concurrency: 2 });
	try {
		store.load();
		assert.deepEqual(store.changes('/repo'), []);
		assert.equal(store.settings().ralphIterations, 7);
		assert.equal(store.settings().concurrency, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the document round-trips through a save and load', () => {
	const { dir, file, store } = scratchStore();
	try {
		store.load();
		const record = store.ensure('/repo', 'add-dark-mode', { title: '加暗色模式' });
		record.status = CHANGE_STATUS.done;
		record.iterations = 2;
		record.tasksTotal = 4;
		record.tasksDone = 4;
		store.save();

		const reopened = new SpecLoopStore({ file });
		reopened.load();
		const restored = reopened.find('/repo', 'add-dark-mode');
		assert.equal(restored.title, '加暗色模式');
		assert.equal(restored.status, CHANGE_STATUS.done);
		assert.equal(restored.iterations, 2);
		assert.equal(restored.tasksDone, 4);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('ensure is idempotent and record order is preserved', () => {
	const { dir, store } = scratchStore();
	try {
		store.load();
		store.ensure('/repo', 'a');
		store.ensure('/repo', 'b');
		const again = store.ensure('/repo', 'a');
		again.title = 'changed';
		assert.deepEqual(
			store.changes('/repo').map((record) => record.id),
			['a', 'b'],
		);
		assert.equal(store.find('/repo', 'a').title, 'changed');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('ensure gives a new change the configured default rounds', () => {
	const { dir, store } = scratchStore({ ralphIterations: 9 });
	try {
		store.load();
		assert.equal(store.ensure('/repo', 'a').maxIterations, 9);
		assert.equal(store.ensure('/repo', 'b', { maxIterations: 2 }).maxIterations, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('an unparseable document is moved aside rather than overwritten', () => {
	const { dir, file, store } = scratchStore();
	try {
		writeFileSync(file, '{ this is not json', 'utf8');
		store.load();
		assert.deepEqual(store.changes('/repo'), []);
		assert.match(store.loadError, /无法解析/);
		const salvaged = readdirSync(dir).filter((name) => name.includes('.corrupt-'));
		assert.equal(salvaged.length, 1, 'the previous document is kept');
		assert.equal(readFileSync(join(dir, salvaged[0]), 'utf8'), '{ this is not json');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('unknown statuses and malformed records are normalized on load', () => {
	const { dir, file, store } = scratchStore();
	try {
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				settings: { ralphIterations: 5 },
				projects: {
					'/repo': {
						changes: [
							{ id: 'ok', status: 'not-a-status', iterations: 'x', log: 'nope' },
							{ status: 'done' },
						],
					},
				},
			}),
			'utf8',
		);
		store.load();
		const record = store.find('/repo', 'ok');
		assert.equal(record.status, CHANGE_STATUS.draft);
		assert.equal(record.iterations, 0);
		assert.deepEqual(record.log, []);
		assert.equal(record.maxIterations, 5);
		assert.equal(store.changes('/repo').length, 1, 'a record with no id is dropped');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
