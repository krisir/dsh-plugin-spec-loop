/**
 * End-to-end tests for the half that decides whether a change ever gets finished:
 * the ralph loop.
 *
 * These drive the real `RalphRunner` against a real scratch OpenSpec project and
 * the real `openspec` CLI, with a fake session seam standing in for the Host. The
 * fake is the point: it lets a test decide exactly what a round does to
 * `tasks.md`, which is the only thing the loop is allowed to be driven by.
 *
 * Creating the changes a loop runs on is covered in `discussion.test.js`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { RalphRunner } from '../host/ralph.js';
import { Proposals } from '../host/proposal.js';
import { SessionSeam } from '../host/session.js';
import { CHANGE_STATUS, SpecLoopStore } from '../host/state.js';

const SESSION_ID = 'loop-session';

/**
 * Build a scratch OpenSpec project plus the fake Host around it.
 *
 * @param {object} [options] - harness options.
 * @param {(context: object) => void | Promise<void>} [options.onPrompt] - what a round does.
 * @param {object} [options.settings] - seed settings.
 * @param {boolean} [options.hasRalph] - whether the agent's toolset contains `ralph`.
 * @returns {object} the harness.
 */
function harness({ onPrompt = () => {}, settings = {}, hasRalph = true } = {}) {
	const projectPath = mkdtempSync(join(tmpdir(), 'spec-loop-proj-'));
	const stateDir = mkdtempSync(join(tmpdir(), 'spec-loop-state-'));
	const file = join(stateDir, 'state.json');
	// Point `$DSH_HOME` at the scratch directory: a test must not leave rubbish in
	// the real `~/.dsh`, and one that did would be reading the last run's leftovers.
	const previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = stateDir;

	const listeners = new Map();
	const agents = new Map();
	const prompts = [];

	const session = {
		id: SESSION_ID,
		events: [],
		append() {},
		snapshotEvents() {
			return this.events;
		},
	};

	const ctx = {
		logger: { info() {} },
		on(event, handler) {
			const list = listeners.get(event) ?? [];
			list.push(handler);
			listeners.set(event, list);
			return () => {
				const index = list.indexOf(handler);
				if (index >= 0) list.splice(index, 1);
			};
		},
		effect(fn) {
			const dispose = fn();
			return () => {
				if (typeof dispose === 'function') dispose();
			};
		},
		inject() {
			return () => {};
		},
		sessions: {
			get(id) {
				return id === 'user-session' ? { header: { cwd: projectPath } } : undefined;
			},
		},
		// The real registry resolves per viewing scope: a tool registered globally can
		// still read as absent for one agent's preset. The seam passes the agent, so
		// this stub answers by name and ignores the scope, which is enough to drive
		// both round shapes through the genuine `SessionSeam.hasTool` path.
		tools: {
			get(name) {
				return hasRalph && name === 'ralph' ? { name: 'ralph' } : undefined;
			},
		},
		agents: {
			get(id) {
				return agents.get(id);
			},
		},
		sessionController: {
			async create() {
				const agent = { id: SESSION_ID, session, status: 'idle' };
				agents.set(SESSION_ID, agent);
				return { sessionId: SESSION_ID };
			},
			async resolveAgent(id) {
				const agent = agents.get(id);
				return agent === undefined ? { error: { code: 'NOT_FOUND' } } : { agent };
			},
			async prompt(request) {
				prompts.push(request.content[0].text);
				const agent = agents.get(SESSION_ID);
				agent.status = 'running';
				for (const handler of listeners.get('agent/status') ?? []) handler({ agent, status: 'running' });
				// The turn is admitted synchronously and runs afterwards, exactly like a
				// real one, so the loop's "idle after running" guard is genuinely tested.
				setTimeout(() => {
					Promise.resolve(onPrompt({ projectPath, prompt: request.content[0].text, session }))
						.catch(() => {})
						.then(() => {
							agent.status = 'idle';
							for (const handler of listeners.get('agent/status') ?? []) handler({ agent, status: 'idle' });
						});
				}, 0);
			},
			cancel() {},
		},
	};

	const store = new SpecLoopStore({ file, seedSettings: settings });
	store.load();
	const privileges = { harden() {}, install: () => () => {}, release() {}, manage() {} };
	const sessions = new SessionSeam({ ctx, privileges });
	sessions.install();
	const commandFor = () => 'openspec';
	const proposals = new Proposals({ store, commandFor });
	const runner = new RalphRunner({ ctx, store, sessions, commandFor, autoApprove: () => false });

	return {
		projectPath,
		store,
		runner,
		proposals,
		sessions,
		prompts,
		settings,
		/**
		 * Wait until the runner has nothing in flight.
		 *
		 * Generous on purpose: every round shells out to the real `openspec` CLI twice,
		 * and the runner is started by `node --test` alongside the other test files.
		 * A tight budget here measures the machine's load, not the loop.
		 */
		async settle(timeoutMs = 90_000) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				if (runner.running.size === 0 && runner.pending.length === 0) return;
				if (Date.now() > deadline) throw new Error('the runner never settled');
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},
		cleanup() {
			runner.dispose();
			sessions.dispose();
			if (previousHome === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previousHome;
			rmSync(projectPath, { recursive: true, force: true });
			rmSync(stateDir, { recursive: true, force: true });
		},
	};
}

/** Write a change's tasks.md with the given checked states. */
function writeTasks(projectPath, id, states) {
	const body = states.map((done, index) => `- [${done ? 'x' : ' '}] 1.${index + 1} 任务 ${index + 1}`).join('\n');
	writeFileSync(join(projectPath, 'openspec', 'changes', id, 'tasks.md'), `${body}\n`, 'utf8');
}

/** Mark the first `count` unchecked tasks done, the way a working agent would. */
function completeTasks(projectPath, id, count) {
	const path = join(projectPath, 'openspec', 'changes', id, 'tasks.md');
	const lines = readFileSync(path, 'utf8').split('\n');
	let remaining = count;
	const next = lines.map((line) => {
		if (remaining <= 0) return line;
		if (!/^\s*-\s*\[ \]/.test(line)) return line;
		remaining -= 1;
		return line.replace('[ ]', '[x]');
	});
	writeFileSync(path, next.join('\n'), 'utf8');
}

/** Create a change on disk with a task list. */
async function seedChange(harnessInstance, id, taskCount) {
	const { Openspec } = await import('../host/openspec.js');
	const openspec = new Openspec({ projectPath: harnessInstance.projectPath, command: 'openspec' });
	await openspec.init();
	await openspec.newChange(id, '测试用 change');
	writeTasks(harnessInstance.projectPath, id, new Array(taskCount).fill(false));
}

test('the ralph loop stops as done once every task is checked', async () => {
	const h = harness({
		settings: { ralphIterations: 5, stallLimit: 3 },
		onPrompt: ({ projectPath }) => completeTasks(projectPath, 'add-thing', 1),
	});
	try {
		await seedChange(h, 'add-thing', 3);
		h.store.mutate(() => h.store.ensure(h.projectPath, 'add-thing', { maxIterations: 5 }));
		h.runner.start(h.projectPath, 'add-thing');
		await h.settle();

		const record = h.store.find(h.projectPath, 'add-thing');
		assert.equal(record.status, CHANGE_STATUS.done);
		assert.equal(record.iterations, 3, 'one task per round, so three rounds');
		assert.equal(record.tasksDone, 3);
		assert.equal(record.tasksTotal, 3);
		assert.equal(record.log.filter((entry) => entry.kind === 'ralph').length, 3);
	} finally {
		h.cleanup();
	}
});

test('the ralph loop reports exhausted when the round budget runs out with work left', async () => {
	const h = harness({
		settings: { ralphIterations: 2, stallLimit: 5 },
		onPrompt: ({ projectPath }) => completeTasks(projectPath, 'big-change', 1),
	});
	try {
		await seedChange(h, 'big-change', 6);
		h.store.mutate(() => h.store.ensure(h.projectPath, 'big-change', { maxIterations: 2 }));
		h.runner.start(h.projectPath, 'big-change');
		await h.settle();

		const record = h.store.find(h.projectPath, 'big-change');
		assert.equal(record.status, CHANGE_STATUS.exhausted);
		assert.equal(record.iterations, 2);
		assert.equal(record.tasksDone, 2);
		assert.match(record.note, /继续/);
	} finally {
		h.cleanup();
	}
});

test('the ralph loop reports blocked after consecutive rounds with no progress', async () => {
	const h = harness({ settings: { ralphIterations: 9, stallLimit: 2 }, onPrompt: () => {} });
	try {
		await seedChange(h, 'stuck', 3);
		h.store.mutate(() => h.store.ensure(h.projectPath, 'stuck', { maxIterations: 9 }));
		h.runner.start(h.projectPath, 'stuck');
		await h.settle();

		const record = h.store.find(h.projectPath, 'stuck');
		assert.equal(record.status, CHANGE_STATUS.blocked);
		assert.equal(record.iterations, 2, 'it stops on the stall limit rather than the budget');
		assert.match(record.note, /没有任何任务被勾选完成/);
	} finally {
		h.cleanup();
	}
});

test('the ralph loop refuses to run a change whose tasks.md has no checkboxes', async () => {
	const h = harness({ settings: { ralphIterations: 3 } });
	try {
		await seedChange(h, 'empty-tasks', 0);
		h.store.mutate(() => h.store.ensure(h.projectPath, 'empty-tasks', { maxIterations: 3 }));
		h.runner.start(h.projectPath, 'empty-tasks');
		await h.settle();

		const record = h.store.find(h.projectPath, 'empty-tasks');
		assert.equal(record.status, CHANGE_STATUS.blocked);
		assert.equal(record.iterations, 0, 'no round is spent when there is nothing to do');
		assert.match(record.note, /没有任何/);
	} finally {
		h.cleanup();
	}
});

test('each round asks the session for one ralph round carrying the pending tasks', async () => {
	const h = harness({
		settings: { ralphIterations: 3, stallLimit: 5 },
		onPrompt: () => {},
		hasRalph: true,
	});
	try {
		await seedChange(h, 'prompted', 2);
		h.store.mutate(() => h.store.ensure(h.projectPath, 'prompted', { maxIterations: 1 }));
		h.runner.start(h.projectPath, 'prompted');
		await h.settle();

		assert.equal(h.prompts.length, 1);
		const [prompt] = h.prompts;
		assert.match(prompt, /第 1\/1 轮/);
		assert.match(prompt, /调用 `ralph` 工具/);
		assert.match(prompt, /maxRounds: 1/);
		assert.match(prompt, /- \[ \] 1\.1 任务 1/);
		assert.match(prompt, /- \[ \] 1\.2 任务 2/);
	} finally {
		h.cleanup();
	}
});

test('a round on an agent without ralph never asks for it', async () => {
	const h = harness({
		settings: { ralphIterations: 1, stallLimit: 5 },
		onPrompt: ({ projectPath }) => completeTasks(projectPath, 'no-ralph', 1),
		hasRalph: false,
	});
	try {
		await seedChange(h, 'no-ralph', 1);
		h.store.mutate(() => h.store.ensure(h.projectPath, 'no-ralph', { maxIterations: 1 }));
		h.runner.start(h.projectPath, 'no-ralph');
		await h.settle();

		const [prompt] = h.prompts;
		assert.doesNotMatch(prompt, /调用 `ralph` 工具/);
		assert.match(prompt, /没有装配 `ralph` 工具/);
		// The round still has to carry the whole job, or suppressing the ralph
		// instruction would have turned one confusing message into a lost round.
		assert.match(prompt, /- \[ \] 1\.1 任务 1/);
		assert.match(prompt, /- \[x\]/);
		assert.equal(h.store.find(h.projectPath, 'no-ralph').status, CHANGE_STATUS.done);
	} finally {
		h.cleanup();
	}
});

test('a change can be run twice, and the second run picks up where the first stopped', async () => {
	const h = harness({
		settings: { ralphIterations: 2, stallLimit: 5 },
		onPrompt: ({ projectPath }) => completeTasks(projectPath, 'resumed', 1),
	});
	try {
		await seedChange(h, 'resumed', 4);
		h.store.mutate(() => h.store.ensure(h.projectPath, 'resumed', { maxIterations: 2 }));
		h.runner.start(h.projectPath, 'resumed');
		await h.settle();
		assert.equal(h.store.find(h.projectPath, 'resumed').tasksDone, 2);

		// Adding rounds is what "continue" does, and it must not reset the count.
		h.runner.start(h.projectPath, 'resumed', { rounds: 2 });
		await h.settle();
		const record = h.store.find(h.projectPath, 'resumed');
		assert.equal(record.status, CHANGE_STATUS.done);
		assert.equal(record.iterations, 4);
		assert.equal(record.tasksDone, 4);
	} finally {
		h.cleanup();
	}
});

test('stopping a queued change marks it cancelled without a round', async () => {
	const h = harness({ settings: { ralphIterations: 3, concurrency: 1 }, onPrompt: () => {} });
	try {
		await seedChange(h, 'first', 2);
		await seedChange(h, 'second', 2);
		h.store.mutate(() => {
			h.store.ensure(h.projectPath, 'first', { maxIterations: 3 });
			h.store.ensure(h.projectPath, 'second', { maxIterations: 3 });
		});
		h.runner.start(h.projectPath, 'first');
		h.runner.start(h.projectPath, 'second');
		const stopped = h.runner.stop(h.projectPath, 'second');
		assert.equal(stopped, true);
		await h.settle();
		assert.equal(h.store.find(h.projectPath, 'second').status, CHANGE_STATUS.cancelled);
		assert.equal(h.store.find(h.projectPath, 'second').iterations, 0);
	} finally {
		h.cleanup();
	}
});

test('a round survives a tools registry that throws when asked', async () => {
	// The probe must never be the reason a change fails: answering "no ralph"
	// costs nothing, while an escaping throw would fail the round outright.
	const h = harness({
		settings: { ralphIterations: 1, stallLimit: 5 },
		onPrompt: ({ projectPath }) => completeTasks(projectPath, 'angry-tools', 1),
		hasRalph: false,
	});
	try {
		h.sessions.ctx.tools = {
			get() {
				throw new Error('registry unavailable');
			},
		};
		await seedChange(h, 'angry-tools', 1);
		h.store.mutate(() => h.store.ensure(h.projectPath, 'angry-tools', { maxIterations: 1 }));
		h.runner.start(h.projectPath, 'angry-tools');
		await h.settle();

		assert.equal(h.prompts.length, 1, 'the round still ran');
		assert.doesNotMatch(h.prompts[0], /调用 `ralph` 工具/);
		assert.equal(h.store.find(h.projectPath, 'angry-tools').status, CHANGE_STATUS.done);
	} finally {
		h.cleanup();
	}
});
