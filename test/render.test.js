/**
 * Render tests for the page.
 *
 * `client.test.js` proves the plugin *registers* correctly, but a registration
 * pointing at a component that throws on its first render is still a broken page
 * — and in a browser that shows up as an empty tab with one console line, which
 * is the most expensive kind of failure to find by hand. So these render the real
 * components with the real React and assert on the markup.
 *
 * The sub-components are rendered directly rather than through the page: each one
 * takes its data as props and fetches nothing, so a straightforward render
 * exercises all of its branches. `SpecLoopPage` is rendered in its pre-snapshot
 * state, and `SpecLoopView` — the same body, with the snapshot as a prop — is
 * rendered in every loaded state. That second one matters: `SpecLoopPage` polls in
 * an effect and effects do not run in a server render, so without `SpecLoopView`
 * the whole loaded page would be untested, and a page that throws once it has data
 * is exactly the failure this file exists to catch.
 */

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { evaluateSources } from '../build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let React;
let renderToStaticMarkup;
let available = true;
try {
	React = (await import('react')).default;
	({ renderToStaticMarkup } = await import('react-dom/server'));
} catch {
	available = false;
}

/**
 * Evaluate the client sources as one body, the way `build.mjs` concatenates them.
 *
 * The built bundle only exports `inject` and `apply`, which is the right public
 * surface but hides the components. Going through `build.mjs` rather than
 * re-reading `src/` here means the preamble and the file order have exactly one
 * definition; `client.test.js` separately covers the built artifact.
 *
 * @returns {object} the page and its pieces.
 */
function loadComponents() {
	return evaluateSources(React);
}

/** A translator that echoes the key, so assertions can name it. */
const t = (key, vars) => (vars === undefined ? key : `${key}(${JSON.stringify(vars)})`);

/** A change record shaped like the host's. */
function change(overrides = {}) {
	return {
		id: 'add-dark-mode',
		title: '加暗色模式',
		summary: '给界面加上暗色主题。',
		status: 'draft',
		iterations: 0,
		maxIterations: 3,
		tasksTotal: 4,
		tasksDone: 0,
		active: false,
		sessionId: '',
		error: '',
		note: '',
		validation: '',
		log: [],
		updatedAt: 1_700_000_000_000,
		...overrides,
	};
}

/** A change whose button is being pressed. */
const loop = { busy: false, act: async () => undefined };

/** Render one element and return its markup. */
function render(element) {
	return renderToStaticMarkup(element);
}

test('the page renders its shell before the first snapshot arrives', { skip: !available }, () => {
	const { SpecLoopPage } = loadComponents();
	// The poll effect never runs in a server render, so this is exactly the first
	// paint: a spinner, and no crash on a null snapshot.
	const markup = render(React.createElement(SpecLoopPage, { t, sessionId: 'session-1' }));
	assert.match(markup, /sl-root/);
	assert.match(markup, /state\.loading/);
	assert.match(markup, /sl-spinner/);
});

test('a change card shows its tallies, a progress bar and the action that applies', { skip: !available }, () => {
	const { ChangeCard } = loadComponents();
	const markup = render(React.createElement(ChangeCard, { t, sessionId: 's', change: change({ tasksDone: 1 }), loop, open: false, onToggle: () => {} }));
	assert.match(markup, /add-dark-mode/);
	assert.match(markup, /status\.draft/);
	// The stub translator echoes its vars into the text, so the rendered markup
	// carries them HTML-escaped; assert on the escaped spelling.
	assert.match(markup, /card\.tasks\(\{&quot;done&quot;:1,&quot;total&quot;:4\}\)/);
	assert.match(markup, /card\.iterations\(\{&quot;done&quot;:0,&quot;max&quot;:3\}\)/);
	assert.match(markup, /role="progressbar"/);
	assert.match(markup, /aria-valuenow="25"/);
	assert.match(markup, /card\.start/, 'never run → 开始');
	assert.match(markup, /card\.details/);
	assert.doesNotMatch(markup, /card\.stop/);
	assert.doesNotMatch(markup, /sl-log-entry/, 'the log is behind 详情');
});

test('the three idle wordings are told apart', { skip: !available }, () => {
	const { ChangeCard } = loadComponents();
	const label = (overrides) =>
		[...render(React.createElement(ChangeCard, { t, sessionId: 's', change: change(overrides), loop, open: false, onToggle: () => {} })).matchAll(/card\.(start|continue|retry)/g)].map((m) => m[1]);

	assert.deepEqual(label({ status: 'draft', iterations: 0 }), ['start']);
	assert.deepEqual(label({ status: 'exhausted', iterations: 2 }), ['continue'], 'budget spent but work left → 继续');
	assert.deepEqual(label({ status: 'done', iterations: 3, tasksDone: 4 }), ['retry'], 'finished → 重试');
});

test('a running change offers stopping, a spinner and no round input', { skip: !available }, () => {
	const { ChangeCard } = loadComponents();
	const markup = render(
		React.createElement(ChangeCard, {
			t,
			sessionId: 's',
			change: change({ status: 'running', active: true, iterations: 1, tasksDone: 2, sessionId: 'session-abcdef1234' }),
			loop,
			open: false,
			onToggle: () => {},
		}),
	);
	assert.match(markup, /card\.stop/);
	assert.doesNotMatch(markup, /card\.start|card\.continue|card\.retry/);
	assert.match(markup, /sl-spinner/);
	assert.doesNotMatch(markup, /type="number"/, 'the budget is not editable mid-run');
	assert.match(markup, /session-a/, 'the session id is reachable so the user can go read it');
});

test('the details pane renders the round log newest-first and the validate output', { skip: !available }, () => {
	const { ChangeCard } = loadComponents();
	const markup = render(
		React.createElement(ChangeCard, {
			t,
			sessionId: 's',
			change: change({
				status: 'blocked',
				iterations: 2,
				tasksDone: 1,
				note: '连续 2 轮没有任何任务被勾选完成',
				validation: 'Warning: spec delta missing',
				log: [
					{ round: 0, kind: 'split', status: 'ok', startedAt: 1, finishedAt: 2, tasksDone: 0, tasksTotal: 0, note: '由需求拆分创建' },
					{ round: 1, kind: 'ralph', status: 'ok', startedAt: 3, finishedAt: 4, tasksDone: 1, tasksTotal: 4, note: '完成了 1.1' },
					{ round: 2, kind: 'ralph', status: 'timeout', startedAt: 5, finishedAt: 6, tasksDone: 1, tasksTotal: 4, note: '超时' },
				],
			}),
			loop,
			open: true,
			onToggle: () => {},
		}),
	);
	assert.match(markup, /连续 2 轮没有任何任务被勾选完成/);
	assert.match(markup, /spec delta missing/);
	assert.match(markup, /log\.split/);
	assert.match(markup, /log\.ralph/);
	assert.match(markup, /log\.timeout/);
	// Newest first, so the timeout is above the successful round.
	assert.ok(markup.indexOf('#2') < markup.indexOf('#1'), 'newest round first');
	assert.doesNotMatch(markup, /log\.ok/, 'a successful round is shown by its checkmark, not the word 完成');
});

test('a change with no rounds says so instead of showing an empty box', { skip: !available }, () => {
	const { ChangeCard } = loadComponents();
	const markup = render(React.createElement(ChangeCard, { t, sessionId: 's', change: change(), loop, open: true, onToggle: () => {} }));
	assert.match(markup, /card\.logEmpty/);
});

test('a change with no checkbox tasks is marked rather than shown as 0%', { skip: !available }, () => {
	const { ChangeCard } = loadComponents();
	const markup = render(React.createElement(ChangeCard, { t, sessionId: 's', change: change({ tasksTotal: 0, tasksDone: 0 }), loop, open: false, onToggle: () => {} }));
	assert.match(markup, /card\.noTasks/);
	assert.match(markup, /aria-valuenow="0"/);
});

test('with no discussion the panel offers the command instead of a textarea', { skip: !available }, () => {
	const { CommandHint } = loadComponents();
	const markup = render(React.createElement(CommandHint, { t }));
	assert.match(markup, /discuss\.title/);
	assert.match(markup, /discuss\.hintBefore/);
	assert.match(markup, /discuss\.copy/);
	assert.match(markup, /discuss\.howItWorks/);
	// The command is the entry point, so the panel must name it — and it must not
	// grow a second, half-working way in.
	assert.match(markup, /\/spec/);
	assert.doesNotMatch(markup, /<textarea/);
});

test('an open discussion shows the requirement, its state and how to nudge', { skip: !available }, () => {
	const { DiscussionPanel } = loadComponents();
	const markup = render(
		React.createElement(DiscussionPanel, {
			t,
			sessionId: 's',
			loop,
			discussion: { status: 'discussing', requirement: '给后台加多租户隔离', proposal: null, dropped: [] },
		}),
	);
	assert.match(markup, /discuss\.status\.discussing/);
	assert.match(markup, /给后台加多租户隔离/);
	assert.match(markup, /discuss\.plan/);
	assert.match(markup, /discuss\.discard/);
	assert.match(markup, /sl-spinner/, 'an open discussion is still being worked on');
});

test('a pending plan renders each entry with its tasks and a confirm button', { skip: !available }, () => {
	const { ProposalPanel } = loadComponents();
	const markup = render(
		React.createElement(ProposalPanel, {
			t,
			sessionId: 's',
			loop,
			discussion: {
				status: 'proposed',
				requirement: 'x',
				proposal: {
					at: 1,
					dropped: [],
					entries: [
						{
							id: 'tenant-tables',
							title: '租户表',
							summary: '建表',
							include: true,
							tasksTotal: 2,
							tasks: [
								{ id: '1.1', description: '加租户表' },
								{ id: '1.2', description: '加行级过滤' },
							],
							specs: ['db/tenancy'],
							problems: [],
						},
						{
							id: 'skipped',
							title: '不要的',
							summary: '',
							include: false,
							tasksTotal: 1,
							tasks: [{ id: '2.1', description: '某个任务' }],
							specs: [],
							problems: [],
						},
					],
				},
			},
		}),
	);
	assert.match(markup, /proposal\.title/);
	assert.match(markup, /proposal\.count\(\{&quot;total&quot;:2,&quot;selected&quot;:1\}\)/);
	assert.match(markup, /proposal\.confirm\(\{&quot;count&quot;:1\}\)/);
	assert.match(markup, /tenant-tables/);
	assert.match(markup, /加租户表/);
	assert.match(markup, /db\/tenancy/);
	// The unselected entry stays visible — it is how the user changes their mind —
	// but its controls are off.
	assert.match(markup, /skipped/);
	assert.match(markup, /sl-proposal-off/);
	// A capability-less change is explained rather than left looking unfinished.
	assert.match(markup, /proposal\.noSpecs/);
});

test('an entry with a lint problem says so before the user confirms', { skip: !available }, () => {
	const { ProposalPanel } = loadComponents();
	const markup = render(
		React.createElement(ProposalPanel, {
			t,
			sessionId: 's',
			loop,
			discussion: {
				status: 'proposed',
				requirement: 'x',
				proposal: {
					at: 1,
					dropped: [{ id: 'no-tasks', reason: 'tasks 里没有任何复选框任务' }],
					entries: [
						{
							id: 'themed',
							title: '主题',
							summary: '',
							include: true,
							tasksTotal: 1,
							tasks: [{ id: '1.1', description: '做一个开关' }],
							specs: ['ui/theming'],
							problems: ['ui/theming：「没有场景」下面没有 `#### Scenario:`'],
						},
					],
				},
			},
		}),
	);
	assert.match(markup, /proposal\.problems/);
	assert.match(markup, /没有场景/);
	assert.match(markup, /proposal\.dropped\(\{&quot;count&quot;:1\}\)/);
	assert.match(markup, /no-tasks/);
});

test('the confirm button is disabled when nothing is selected', { skip: !available }, () => {
	const { ProposalPanel } = loadComponents();
	const markup = render(
		React.createElement(ProposalPanel, {
			t,
			sessionId: 's',
			loop,
			discussion: {
				status: 'proposed',
				requirement: 'x',
				proposal: {
					at: 1,
					dropped: [],
					entries: [
						{ id: 'only', title: '唯一', summary: '', include: false, tasksTotal: 1, tasks: [{ id: '1.1', description: 'x' }], specs: [], problems: [] },
					],
				},
			},
		}),
	);
	assert.match(markup, /disabled=""/);
	assert.match(markup, /proposal\.confirm\(\{&quot;count&quot;:0\}\)/);
});

test('the settings panel renders every field the host accepts', { skip: !available }, () => {
	const { SettingsPanel } = loadComponents();
	const markup = render(
		React.createElement(SettingsPanel, {
			t,
			loop,
			settings: {
				ralphIterations: 3,
				concurrency: 2,
				iterationTimeoutMinutes: 45,
				stallLimit: 2,
				autoApprove: true,
				openspecCommand: 'openspec',
			},
			onClose: () => {},
		}),
	);
	for (const field of [
		'settings.defaultRounds',
		'settings.concurrency',
		'settings.timeout',
		'settings.stall',
		'settings.autoApprove',
		'settings.command',
		'settings.save',
	]) {
		assert.ok(markup.includes(field), `${field} is rendered`);
	}
	assert.match(markup, /type="number"/);
	assert.match(markup, /type="checkbox"/);
	assert.match(markup, /checked=""/, 'autoApprove is on');
	assert.match(markup, /value="openspec"/);
});

/**
 * A snapshot in the shape the host serves.
 * @param {object} [overrides] - top-level fields to replace.
 * @returns {object} the snapshot.
 */
function snapshot(overrides = {}) {
	return {
		version: 1,
		now: 1_700_000_000_000,
		projectPath: '/repo',
		openspec: { available: true, initialized: true, root: '/repo', executable: '/usr/bin/openspec' },
		settings: { ralphIterations: 3, concurrency: 1, iterationTimeoutMinutes: 45, stallLimit: 2, autoApprove: true, openspecCommand: 'openspec' },
		changes: [],
		discussion: null,
		...overrides,
	};
}

/** A loop that nothing can be clicked through. */
const idleLoop = { busy: false, loadError: '', actionError: '', actionNote: '', act: async () => undefined, reload: () => {} };

/**
 * Render the loaded page.
 * @param {object} state - the snapshot.
 * @returns {string} the markup.
 */
function renderPage(state) {
	return render(React.createElement(loadComponents().SpecLoopView, { t, sessionId: 'session-1', loop: idleLoop, state }));
}

test('the loaded page offers the command when there is no discussion', { skip: !available }, () => {
	const markup = renderPage(snapshot());
	assert.match(markup, /page\.title/);
	assert.match(markup, /discuss\.hintBefore/, 'no discussion → the command hint');
	assert.doesNotMatch(markup, /discuss\.requirement/);
	assert.match(markup, /list\.empty/, 'and no changes yet');
});

test('the loaded page shows an open discussion and hides the command hint', { skip: !available }, () => {
	const markup = renderPage(
		snapshot({ discussion: { status: 'discussing', requirement: '给后台加多租户隔离', proposal: null } }),
	);
	assert.match(markup, /discuss\.requirement/);
	assert.match(markup, /给后台加多租户隔离/);
	assert.match(markup, /discuss\.status\.discussing/);
	assert.doesNotMatch(markup, /discuss\.hintBefore/, 'the command hint gives way to the discussion');
});

test('the loaded page shows a pending plan and its confirm button', { skip: !available }, () => {
	const markup = renderPage(
		snapshot({
			discussion: {
				status: 'proposed',
				requirement: '加多租户隔离',
				proposal: {
					at: 1,
					dropped: [],
					entries: [
						{ id: 'tenancy', title: '租户隔离', summary: '', include: true, tasksTotal: 1, tasks: [{ id: '1.1', description: '加列' }], specs: [], problems: [] },
					],
				},
			},
		}),
	);
	assert.match(markup, /proposal\.title/);
	assert.match(markup, /proposal\.confirm\(\{&quot;count&quot;:1\}\)/);
	assert.match(markup, /tenancy/);
});

test('the loaded page lists changes alongside an open discussion', { skip: !available }, () => {
	const markup = renderPage(
		snapshot({
			changes: [change(), change({ id: 'second', title: '第二个', status: 'done', tasksDone: 4 })],
			discussion: { status: 'discussing', requirement: '再加一件事', proposal: null },
		}),
	);
	assert.match(markup, /list\.count\(\{&quot;count&quot;:2\}\)/);
	assert.match(markup, /加暗色模式/);
	assert.match(markup, /第二个/);
	assert.match(markup, /discuss\.requirement/);
});

test('a discussion counts as work in flight, so the page keeps its spinner', { skip: !available }, () => {
	// The spinner is the only thing telling the user the agent is still thinking
	// between turns; losing it during a discussion means a page that looks stuck.
	const discussing = renderPage(snapshot({ discussion: { status: 'discussing', requirement: 'x', proposal: null } }));
	assert.match(discussing, /sl-spinner/);

	const idle = renderPage(snapshot());
	assert.doesNotMatch(idle, /sl-spinner/, 'an idle page is not spinning');
});

test('rendering never throws for any status the host can report', { skip: !available }, () => {
	const { ChangeCard } = loadComponents();
	for (const status of ['draft', 'queued', 'running', 'done', 'exhausted', 'blocked', 'failed', 'cancelled']) {
		const markup = render(
			React.createElement(ChangeCard, {
				t,
				sessionId: 's',
				change: change({ status, active: status === 'running' || status === 'queued', error: status === 'failed' ? '炸了' : '' }),
				loop,
				open: true,
				onToggle: () => {},
			}),
		);
		assert.ok(markup.includes(`status.${status}`), status);
	}
});

test('a change with a long error and summary does not lose its controls', { skip: !available }, () => {
	const { ChangeCard } = loadComponents();
	const markup = render(
		React.createElement(ChangeCard, {
			t,
			sessionId: 's',
			change: change({ status: 'failed', error: 'x'.repeat(4000), summary: 'y'.repeat(4000) }),
			loop,
			open: false,
			onToggle: () => {},
		}),
	);
	assert.match(markup, /card\.retry|card\.start/);
	assert.ok(markup.length < 20_000, 'the summary is clipped rather than rendered whole');
});
