import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ROUNDS_PER_INVOCATION, renderObjective, renderRoundPrompt } from '../host/ralph.js';

const RECORD = { id: 'add-dark-mode', title: '加暗色模式', maxIterations: 3, iterations: 0 };
const CHANGE_DIR = '/repo/openspec/changes/add-dark-mode';
const INFO = {
	progress: { total: 3, complete: 1, remaining: 2 },
	tasks: [
		{ id: '1', description: '搭骨架', done: true },
		{ id: '2', description: '写样式', done: false },
		{ id: '3', description: '跑测试', done: false },
	],
};

test('the objective carries the change identity, the pending tasks and the done-condition', () => {
	const objective = renderObjective({ record: RECORD, changeDir: CHANGE_DIR, info: INFO });
	assert.match(objective, /add-dark-mode/);
	assert.match(objective, /加暗色模式/);
	assert.match(objective, new RegExp(CHANGE_DIR));
	assert.match(objective, /已完成 1\/3 条任务/);
	assert.match(objective, /- \[ \] 写样式/);
	assert.match(objective, /- \[ \] 跑测试/);
	assert.doesNotMatch(objective, /- \[ \] 搭骨架/, 'finished tasks are not re-issued');
	assert.match(objective, /- \[x\]/, 'it tells the worker how to record progress');
});

test('the objective tells a fresh agent that the workspace is the memory', () => {
	const objective = renderObjective({ record: RECORD, changeDir: CHANGE_DIR, info: INFO });
	assert.match(objective, /共享工作区是跨轮唯一的长期记忆/);
	assert.match(objective, /阻塞：/);
});

test('the objective tolerates an empty task list', () => {
	const objective = renderObjective({
		record: RECORD,
		changeDir: CHANGE_DIR,
		info: { progress: { total: 0, complete: 0, remaining: 0 }, tasks: [] },
	});
	assert.match(objective, /已经没有未完成任务/);
});

test('a round whose agent has ralph asks for it, passes the objective verbatim and caps rounds at one', () => {
	const objective = renderObjective({ record: RECORD, changeDir: CHANGE_DIR, info: INFO });
	const prompt = renderRoundPrompt({ record: RECORD, objective, round: 2, maxRounds: 5, hasRalph: true });
	assert.match(prompt, /第 2\/5 轮/);
	assert.match(prompt, /调用 `ralph` 工具/);
	assert.match(prompt, /逐字/);
	assert.match(prompt, new RegExp(`maxRounds: ${ROUNDS_PER_INVOCATION}`));
	assert.equal(ROUNDS_PER_INVOCATION, 1, 'one round per invocation is what makes the page count honest');
	assert.ok(prompt.includes(objective), 'the objective is embedded whole');
	// A visible tool can still fail to start, so the fallback clause stays.
	assert.match(prompt, /如果调用 `ralph` 失败/);
});

test('a round whose agent has no ralph is never told to call it', () => {
	const prompt = renderRoundPrompt({ record: RECORD, objective: 'x', round: 1, maxRounds: 1, hasRalph: false });
	// This is the whole point of asking the registry: the model should not have to
	// discover the absence and announce it, which is what filled every round's
	// opening line with "ralph 不可用" and made a working loop look broken.
	assert.doesNotMatch(prompt, /调用 `ralph` 工具/);
	assert.doesNotMatch(prompt, /如果调用 `ralph` 失败/);
	assert.match(prompt, /没有装配 `ralph` 工具/);
	assert.match(prompt, /你本人/);
	// The wording may name the tool; it must never instruct a call to it.
	assert.doesNotMatch(prompt, /maxRounds:/);
});

test('both round shapes insist on the tasks.md tick, which is the only progress signal', () => {
	for (const hasRalph of [true, false]) {
		const prompt = renderRoundPrompt({ record: RECORD, objective: 'x', round: 1, maxRounds: 1, hasRalph });
		assert.match(prompt, /tasks\.md/, `hasRalph=${hasRalph}`);
		assert.match(prompt, /- \[x\]/, `hasRalph=${hasRalph}`);
		assert.match(prompt, /不勾就等于这一轮白跑/, `hasRalph=${hasRalph}`);
	}
});
