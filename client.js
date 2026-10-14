/**
 * dsh-plugin-spec-loop — browser half.
 *
 * GENERATED FILE — do not edit. Edit src/*.js and run `node build.mjs`.
 * Sources are concatenated in filename order into one factory body; see
 * build.mjs for why they cannot be separate modules.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-spec-loop",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } = React;
		const h = React.createElement;

		//#region src/00-util.js
/**
 * Shared constants and formatting helpers for the browser half.
 *
 * The page is a plain-JS plugin with no type check against the shipped client
 * packages, so the smaller the surface it builds on, the less there is to break
 * silently. Everything here is pure and takes its translator as an argument.
 */

/** The locale namespace this plugin registers its dictionaries under. */
const NS = 'specLoop';

/**
 * The view id, which is also the tab key the shell remembers per session.
 *
 * It must not collide with a shipped view: reusing `chat` or `trajectory` would
 * take over that cell and replace the built-in page instead of sitting beside it.
 */
const VIEW_ID = 'spec-loop';

/** How often the page re-reads the host while work is happening. */
const POLL_ACTIVE_MS = 2500;

/** How often it re-reads when nothing is moving. */
const POLL_IDLE_MS = 8000;

/** The statuses the host can report, in the order the page lists them. */
const STATUS_KEYS = ['draft', 'queued', 'running', 'done', 'exhausted', 'blocked', 'failed', 'cancelled'];

/**
 * Which colour family each status belongs to.
 *
 * Kept to the four theme states plus idle, because inventing a colour for
 * "exhausted" would mean inventing a token, and a raw hex value is the one thing
 * that breaks in the other theme.
 */
const STATUS_TONE = {
	draft: 'idle',
	queued: 'busy',
	running: 'busy',
	done: 'ok',
	exhausted: 'warn',
	blocked: 'warn',
	failed: 'error',
	cancelled: 'idle',
};

/** Statuses that mean a round is in flight or about to be. */
const ACTIVE_STATUS_KEYS = new Set(['queued', 'running']);

/**
 * A locale time string.
 * @param {number} ms - the instant.
 * @returns {string} a short local clock.
 */
function formatClock(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return '—';
	try {
		return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
	} catch {
		return '—';
	}
}

/**
 * A coarse "time from now" phrase.
 * @param {number} ms - the instant.
 * @param {(key: string, vars?: object) => string} t - translator.
 * @returns {string} the phrase.
 */
function formatRelative(ms, t) {
	if (!Number.isFinite(ms) || ms <= 0) return '—';
	const delta = ms - Date.now();
	const future = delta >= 0;
	const minutes = Math.round(Math.abs(delta) / 60000);
	if (minutes < 1) return future ? t('time.inAMoment') : t('time.justNow');
	const amount =
		minutes < 60
			? t('duration.minutes', { count: minutes })
			: minutes < 60 * 36
				? t('duration.hours', { count: Math.round(minutes / 60) })
				: t('duration.days', { count: Math.round(minutes / (60 * 24)) });
	return future ? t('time.in', { amount }) : t('time.ago', { amount });
}

/**
 * A percentage, guarded against a zero total.
 * @param {number} done - completed tasks.
 * @param {number} total - total tasks.
 * @returns {number} 0–100.
 */
function percent(done, total) {
	if (!Number.isFinite(total) || total <= 0) return 0;
	return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/**
 * A trimmed string, with an ellipsis when it was cut.
 * @param {unknown} value - the candidate.
 * @param {number} limit - the maximum length.
 * @returns {string} the result.
 */
function clip(value, limit) {
	const text = typeof value === 'string' ? value.trim() : '';
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}…`;
}

/**
 * The tone for a change's status pill.
 * @param {string} status - the status.
 * @returns {string} a tone name.
 */
function toneOf(status) {
	return STATUS_TONE[status] ?? 'idle';
}

/**
 * The distinguishing part of a session id, for a button label.
 *
 * Taking a plain prefix of the whole id renders the same eight characters for
 * every session the Host ever creates, because they all begin with `session-`:
 * a row of `session-` chips tells you nothing about which one is which. So the
 * shared prefix comes off first, and the budget is spent on the part that varies.
 *
 * @param {unknown} id - the session id.
 * @returns {string} a short, distinguishing label.
 */
function shortSessionId(id) {
	const text = typeof id === 'string' ? id : '';
	const prefix = 'session-';
	const body = text.startsWith(prefix) ? text.slice(prefix.length) : text;
	return body.slice(0, 8);
}
		//#endregion

		//#region src/05-locale.js
/**
 * Dictionaries for the page.
 *
 * Simplified Chinese is the key-set source of truth: every key the page asks for
 * exists here first, and the English map is checked against it by the test suite
 * rather than by eye.
 */

/** Simplified Chinese dictionary. */
const zh = {
	'view.label': '规格',
	'page.title': 'Spec Loop',
	'page.subtitle': '把需求拆成 OpenSpec change，再用 ralph 逐轮推进',

	'state.loading': '正在读取…',
	'state.noProject': '这个会话还没有工作目录，插件无法确定要在哪个项目里操作 openspec。先给会话一个工作目录。',
	'state.noOpenspec': '找不到 openspec 命令。请先安装 OpenSpec（npm i -g @fission-ai/openspec），或在设置里填写绝对路径。',
	'state.notInitialized': '这个项目还没有 openspec 目录。点「初始化」会执行 openspec init --tools none。',
	'state.stale': '状态文件读取有问题：{message}',
	'state.loadFailed': '读取状态失败：{message}',

	'init.button': '初始化 OpenSpec',
	'init.running': '正在初始化…',

	'discuss.title': '需求讨论',
	'discuss.hintBefore': '在下面的输入框里输入',
	'discuss.hintAfter': '，后面跟你的需求，就能开始一轮拆分讨论。',
	'discuss.copy': '复制 /spec',
	'discuss.copied': '已复制',
	'discuss.howItWorks':
		'agent 会先读仓库、问你几个问题；聊清楚之后它把计划提交上来，你在这里勾选、改名，确认之后才会真正创建 OpenSpec change。',
	'discuss.requirement': '讨论中的需求',
	'discuss.status.discussing': '讨论中',
	'discuss.status.proposed': '计划已提交，等你确认',
	'discuss.plan': '让它现在出计划',
	'discuss.planSent': '已经让它整理计划了。',
	'discuss.discard': '放弃这次讨论',
	'discuss.discardConfirm': '确认放弃？',
	'discuss.discardHint': '只清掉这条待确认的需求，仓库里从来没创建过任何 change。',
	'discuss.discarded': '已放弃。',

	'proposal.title': '待确认的计划',
	'proposal.count': '{total} 个 change，已勾选 {selected} 个',
	'proposal.include': '创建这个 change',
	'proposal.noTasks': '没有任务',
	'proposal.tasks': '{count} 个任务',
	'proposal.specs': 'capability：{list}',
	'proposal.noSpecs': '不改变外部行为，会加上 skip_specs',
	'proposal.problems': '可能通不过校验：{list}',
	'proposal.dropped': '有 {count} 个条目被丢弃',
	'proposal.detail': '看全文',
	'proposal.hideDetail': '收起全文',
	'proposal.detailLoading': '读取中…',
	'proposal.detailFailed': '读取失败：{message}',
	'proposal.confirm': '确认创建 {count} 个 change',
	'proposal.confirming': '正在创建…',
	'proposal.confirmHint': '确认后才会在 openspec/changes 下建目录并写入 proposal / specs / design / tasks。',
	'proposal.created': '已创建 {count} 个 change。',
	'proposal.createdWarnings': '已创建，但有提醒：{list}',

	'list.title': 'change 列表',
	'list.count': '共 {count} 个',
	'list.refresh': '刷新',
	'list.runAll': '全部开始',
	'list.settings': '设置',
	'list.empty': '还没有 change。用 /spec 开始一次需求讨论，确认之后创建的 change 会出现在这里。',
	'list.importedNote': '刷新时会把 openspec/changes 里存在但列表中没有的 change 一并导入。',

	'card.iterations': '迭代 {done}/{max}',
	'card.tasks': '任务 {done}/{total}',
	'card.noTasks': '没有任务',
	'card.session': '会话',
	'card.openSession': '打开会话',
	'card.copySession': '复制会话 id',
	'card.start': '开始迭代',
	'card.continue': '继续迭代',
	'card.stop': '停止',
	'card.retry': '重试',
	'card.delete': '从列表移除',
	'card.deleteConfirm': '确认移除？',
	'card.deleteHint': '只从列表移除，不会删除仓库里的 openspec/changes 目录。',
	'card.details': '详情',
	'card.hideDetails': '收起',
	'card.log': '迭代记录',
	'card.logEmpty': '还没有跑过任何一轮。',
	'card.validation': 'openspec validate',
	'card.rounds': '轮数',
	'card.roundsSave': '保存',
	'card.updatedAt': '更新于 {time}',

	'status.draft': '未开始',
	'status.queued': '排队中',
	'status.running': '迭代中',
	'status.done': '已完成',
	'status.exhausted': '轮数用尽',
	'status.blocked': '需要处理',
	'status.failed': '失败',
	'status.cancelled': '已停止',

	'log.split': '需求拆分',
	'log.ralph': 'ralph 轮次',
	'log.ok': '完成',
	'log.error': '出错',
	'log.timeout': '超时',
	'log.cancelled': '已取消',

	'settings.title': '设置',
	'settings.close': '关闭',
	'settings.defaultRounds': '新 change 的默认轮数',
	'settings.defaultRoundsHint': '拆分需求时每个 change 的初始轮数，也可以在卡片上单独改。',
	'settings.concurrency': '同时迭代的 change 数',
	'settings.concurrencyHint': '并发越高越快，但会同时开多个会话，也更费额度。',
	'settings.timeout': '单轮超时（分钟）',
	'settings.timeoutHint': '一轮 ralph 超过这个时间就被取消，避免一直挂着。',
	'settings.stall': '无进展容忍轮数',
	'settings.stallHint': '连续这么多轮没有任何任务被完成，就停下来标记为「需要处理」。',
	'settings.autoApprove': '自动跳过授权',
	'settings.autoApproveHint':
		'插件驱动的会话切到完全访问权限并自动批准工具调用。关掉后，无人值守的轮次可能会卡在授权请求上。',
	'settings.command': 'openspec 命令',
	'settings.commandHint': '留空用 PATH 里的 openspec；GUI 启动的 Host 常常找不到它，这时填绝对路径。',
	'settings.save': '保存设置',
	'settings.saved': '已保存',
	'settings.saveFailed': '保存失败：{message}',
	'settings.dirty': '有未保存的修改',

	'time.inAMoment': '马上',
	'time.justNow': '刚刚',
	'time.in': '{amount}后',
	'time.ago': '{amount}前',
	'duration.minutes': '{count} 分钟',
	'duration.hours': '{count} 小时',
	'duration.days': '{count} 天',

	'action.failed': '操作失败：{message}',
};

/** English dictionary. */
const en = {
	'view.label': 'Spec',
	'page.title': 'Spec Loop',
	'page.subtitle': 'Split a requirement into OpenSpec changes, then drive each one with ralph rounds',

	'state.loading': 'Loading…',
	'state.noProject': 'This session has no working directory, so the plugin cannot tell which project to work in.',
	'state.noOpenspec': 'The openspec command was not found. Install OpenSpec (npm i -g @fission-ai/openspec) or set an absolute path in settings.',
	'state.notInitialized': 'This project has no openspec directory yet. "Initialize" runs openspec init --tools none.',
	'state.stale': 'The state file could not be read cleanly: {message}',
	'state.loadFailed': 'Could not read state: {message}',

	'init.button': 'Initialize OpenSpec',
	'init.running': 'Initializing…',

	'discuss.title': 'Requirement discussion',
	'discuss.hintBefore': 'Type',
	'discuss.hintAfter': ' in the composer below, followed by your requirement, to open a discussion.',
	'discuss.copy': 'Copy /spec',
	'discuss.copied': 'Copied',
	'discuss.howItWorks':
		'The agent reads the repository and asks you a few questions first. Once the two of you have settled it, the plan arrives here for you to select and rename; the OpenSpec changes are created only after you confirm.',
	'discuss.requirement': 'Requirement under discussion',
	'discuss.status.discussing': 'Discussing',
	'discuss.status.proposed': 'Plan submitted, waiting for you',
	'discuss.plan': 'Ask for the plan now',
	'discuss.planSent': 'Asked the agent to write up the plan.',
	'discuss.discard': 'Discard this discussion',
	'discuss.discardConfirm': 'Discard?',
	'discuss.discardHint': 'Clears this pending requirement. Nothing was ever created in the repository.',
	'discuss.discarded': 'Discarded.',

	'proposal.title': 'Plan awaiting confirmation',
	'proposal.count': '{total} change(s), {selected} selected',
	'proposal.include': 'Create this change',
	'proposal.noTasks': 'No tasks',
	'proposal.tasks': '{count} task(s)',
	'proposal.specs': 'Capabilities: {list}',
	'proposal.noSpecs': 'Changes no external behaviour; skip_specs will be set',
	'proposal.problems': 'May fail validation: {list}',
	'proposal.dropped': '{count} entr(ies) were dropped',
	'proposal.detail': 'Full text',
	'proposal.hideDetail': 'Hide full text',
	'proposal.detailLoading': 'Loading…',
	'proposal.detailFailed': 'Could not load: {message}',
	'proposal.confirm': 'Create {count} change(s)',
	'proposal.confirming': 'Creating…',
	'proposal.confirmHint': 'Only after this does anything appear under openspec/changes, with proposal / specs / design / tasks written.',
	'proposal.created': 'Created {count} change(s).',
	'proposal.createdWarnings': 'Created, with warnings: {list}',

	'list.title': 'Changes',
	'list.count': '{count} total',
	'list.refresh': 'Refresh',
	'list.runAll': 'Start all',
	'list.settings': 'Settings',
	'list.empty': 'No changes yet. Start a discussion with /spec; the changes you confirm will show up here.',
	'list.importedNote': 'Refreshing also imports changes that exist under openspec/changes but are missing from the list.',

	'card.iterations': 'Rounds {done}/{max}',
	'card.tasks': 'Tasks {done}/{total}',
	'card.noTasks': 'No tasks',
	'card.session': 'Session',
	'card.openSession': 'Open session',
	'card.copySession': 'Copy session id',
	'card.start': 'Start',
	'card.continue': 'Add rounds',
	'card.stop': 'Stop',
	'card.retry': 'Retry',
	'card.delete': 'Remove from list',
	'card.deleteConfirm': 'Remove?',
	'card.deleteHint': 'Removes it from the list only; the openspec/changes directory is left alone.',
	'card.details': 'Details',
	'card.hideDetails': 'Hide',
	'card.log': 'Round log',
	'card.logEmpty': 'No rounds have run yet.',
	'card.validation': 'openspec validate',
	'card.rounds': 'Rounds',
	'card.roundsSave': 'Save',
	'card.updatedAt': 'Updated {time}',

	'status.draft': 'Not started',
	'status.queued': 'Queued',
	'status.running': 'Running',
	'status.done': 'Done',
	'status.exhausted': 'Rounds used up',
	'status.blocked': 'Needs attention',
	'status.failed': 'Failed',
	'status.cancelled': 'Stopped',

	'log.split': 'Requirement split',
	'log.ralph': 'ralph round',
	'log.ok': 'done',
	'log.error': 'error',
	'log.timeout': 'timeout',
	'log.cancelled': 'cancelled',

	'settings.title': 'Settings',
	'settings.close': 'Close',
	'settings.defaultRounds': 'Default rounds for new changes',
	'settings.defaultRoundsHint': 'The starting round count for each change a split creates. Also editable per card.',
	'settings.concurrency': 'Changes iterating at once',
	'settings.concurrencyHint': 'Higher is faster, but opens several sessions at once and spends quota accordingly.',
	'settings.timeout': 'Round timeout (minutes)',
	'settings.timeoutHint': 'A ralph round is cancelled once it runs longer than this.',
	'settings.stall': 'Rounds allowed with no progress',
	'settings.stallHint': 'After this many consecutive rounds with no task completed, the change is marked as needing attention.',
	'settings.autoApprove': 'Skip authorizations',
	'settings.autoApproveHint':
		'Plugin-driven sessions switch to full access and auto-approve tool calls. With this off, an unattended round can stall on an approval request.',
	'settings.command': 'openspec command',
	'settings.commandHint': 'Empty uses the openspec on PATH; a GUI-launched Host often cannot find it, so an absolute path helps.',
	'settings.save': 'Save settings',
	'settings.saved': 'Saved',
	'settings.saveFailed': 'Save failed: {message}',
	'settings.dirty': 'Unsaved changes',

	'time.inAMoment': 'in a moment',
	'time.justNow': 'just now',
	'time.in': 'in {amount}',
	'time.ago': '{amount} ago',
	'duration.minutes': '{count} min',
	'duration.hours': '{count} h',
	'duration.days': '{count} d',

	'action.failed': 'Action failed: {message}',
};
		//#endregion

		//#region src/10-api.js
/**
 * The page's link to the host half.
 *
 * The browser cannot call a third-party host plugin through the generated Remote
 * protocol — the client side of that protocol needs a build-time generated
 * artifact this plugin does not have — so the plugin exposes a plain HTTP route
 * and the page talks to it with `fetch`. Relative URLs work in both hosts: the
 * shipped Web server serves the route directly, and the desktop shell carries
 * `fetch` over its IPC bridge.
 *
 * Every call names the **session** the page is showing. The host resolves that to
 * a project directory, which is what makes a change belong to a repository: the
 * page never sends a path, because it does not know one and a client that named
 * its own could aim the loop at any tree on the machine.
 *
 * Every response is `{ error: { code, message } }` on failure, so the page always
 * has something specific to show instead of a bare status code.
 */

/** The route prefix the host half registers. */
const API_BASE = '/dsh-spec-loop/api';

/** An error carrying the host's machine-readable code. */
class ApiError extends Error {
	/**
	 * @param {number} status - the HTTP status.
	 * @param {string} code - the host's code.
	 * @param {string} message - the host's message.
	 */
	constructor(status, code, message) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * Perform one request against the loop route.
 * @param {string} path - route path below the prefix.
 * @param {object} [init] - fetch options.
 * @returns {Promise<object>} the parsed body.
 */
async function apiRequest(path, init) {
	let response;
	try {
		response = await fetch(API_BASE + path, init);
	} catch (error) {
		throw new ApiError(0, 'UNREACHABLE', String(error && error.message ? error.message : error));
	}
	const text = await response.text();
	let body = null;
	if (text.length > 0) {
		try {
			body = JSON.parse(text);
		} catch {
			body = null;
		}
	}
	if (!response.ok) {
		const detail = body && body.error ? body.error : {};
		throw new ApiError(
			response.status,
			detail.code || 'HTTP_' + response.status,
			detail.message || response.statusText,
		);
	}
	return body ?? {};
}

/** POST a JSON body. */
function post(path, body) {
	return apiRequest(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body ?? {}),
	});
}

/**
 * Read the whole snapshot the page renders from.
 * @param {string} sessionId - the session to read for.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} the snapshot.
 */
function fetchState(sessionId, signal) {
	return apiRequest(`/state?sessionId=${encodeURIComponent(sessionId)}`, { signal });
}

/**
 * Read one proposal entry's full artifact bodies.
 *
 * Fetched on demand rather than carried in the snapshot: the page polls every
 * few seconds while a discussion is open, and every proposed spec on every tick
 * would be a lot of Markdown to render a checklist it does not use.
 *
 * @param {string} sessionId - the session to read for.
 * @param {string} id - the entry id.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} the entry's artifacts.
 */
function fetchEntry(sessionId, id, signal) {
	return apiRequest(`/draft/entry?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`, { signal });
}

/**
 * Confirm a draft by selecting and renaming its entries.
 * @param {string} sessionId - the session.
 * @param {object} entries - entry id → `{ include?, title?, summary? }`.
 * @returns {Promise<object>} the response.
 */
function updateDraft(sessionId, entries) {
	return post('/draft/update', { sessionId, entries });
}

/**
 * Create every selected entry of the pending plan.
 *
 * This is the page's confirm button, and it is the same host operation `/spec
 * apply` performs — not a second implementation of it.
 *
 * @param {string} sessionId - the session confirming.
 * @returns {Promise<object>} the created ids and any warnings.
 */
function applyDraft(sessionId) {
	return post('/draft/apply', { sessionId });
}

/**
 * Ask the agent to write up the plan now.
 *
 * A nudge is a message to the agent, and only the host can send one — the page
 * has no way to talk to a session. So the button is a route, not a suggestion:
 * the host renders the same nudge `/spec plan` does.
 *
 * @param {string} sessionId - the session to nudge.
 * @returns {Promise<object>} the response.
 */
function planDraft(sessionId) {
	return post('/draft/plan', { sessionId });
}

/** Throw away the pending requirement of one session. */
function discardDraft(sessionId) {
	return post('/draft/discard', { sessionId });
}

/** The route verbs, so no component has to spell a URL. */
const api = {
	init: (sessionId) => post('/init', { sessionId }),
	fetchEntry,
	updateDraft,
	planDraft,
	applyDraft,
	discardDraft,
	run: (sessionId, id, rounds) => post('/changes/run', { sessionId, id, rounds }),
	runAll: (sessionId, rounds) => post('/changes/runAll', { sessionId, rounds }),
	stop: (sessionId, id) => post('/changes/stop', { sessionId, id }),
	update: (sessionId, id, patch) => post('/changes/update', { sessionId, id, ...patch }),
	remove: (sessionId, id) => post('/changes/delete', { sessionId, id }),
	refresh: (sessionId) => post('/changes/refresh', { sessionId }),
	saveSettings: (sessionId, settings) => post('/settings', { sessionId, settings }),
};
		//#endregion

		//#region src/20-store.js
/**
 * The page's client-side state: one polling read plus the mutations that follow
 * it.
 *
 * Two decisions are worth naming.
 *
 * **The poll rate is derived, not chosen.** When a discussion or a round is in
 * flight the page re-reads every few seconds, because that is when the numbers
 * move; when nothing is running it backs off, because a list that is not changing
 * does not need to be fetched. That keeps the page live without making an idle
 * tab a busy loop.
 *
 * **A hidden tab stops polling.** The host is a local process and the page may sit
 * open for hours behind other windows; a background tab that keeps asking is pure
 * waste. Coming back into view re-reads immediately, so the user never sees stale
 * numbers.
 */

/**
 * Read and mutate the host's snapshot.
 *
 * @param {string} sessionId - the session the page is showing.
 * @returns {object} the state, the errors, and the actions.
 */
function useLoopState(sessionId) {
	const [state, setState] = React.useState(null);
	const [loadError, setLoadError] = React.useState('');
	const [actionError, setActionError] = React.useState('');
	const [actionNote, setActionNote] = React.useState('');
	const [busy, setBusy] = React.useState(false);
	const [tick, setTick] = React.useState(0);

	/** Force an immediate re-read. */
	const reload = React.useCallback(() => setTick((value) => value + 1), []);

	React.useEffect(() => {
		if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
		let cancelled = false;
		let timer;
		let controller = new AbortController();

		const schedule = (delay) => {
			timer = setTimeout(run, delay);
		};

		const busyNow = (snapshot) => {
			if (snapshot === null) return true;
			// A discussion counts as active: the agent is thinking between turns, and
			// the plan appears in the panel without the user reloading to find it.
			if (snapshot.discussion !== null && snapshot.discussion !== undefined) return true;
			return (snapshot.changes ?? []).some((change) => change.active === true);
		};

		const run = async () => {
			controller = new AbortController();
			let snapshot = null;
			try {
				snapshot = await fetchState(sessionId, controller.signal);
			} catch (error) {
				if (cancelled || error?.name === 'AbortError') return;
				setLoadError(error instanceof Error ? error.message : String(error));
				schedule(POLL_IDLE_MS);
				return;
			}
			if (cancelled) return;
			setLoadError('');
			setState(snapshot);
			const hidden = typeof document !== 'undefined' && document.hidden === true;
			const delay = busyNow(snapshot) ? (hidden ? POLL_ACTIVE_MS * 4 : POLL_ACTIVE_MS) : POLL_IDLE_MS;
			schedule(delay);
		};

		schedule(0);
		const onVisible = () => {
			if (typeof document !== 'undefined' && document.hidden !== true) {
				clearTimeout(timer);
				schedule(0);
			}
		};
		if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			controller.abort();
			if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
		};
	}, [sessionId, tick]);

	/**
	 * Run one mutation, folding its snapshot back in and surfacing its failure.
	 *
	 * Every call takes `{ state }`, so a mutation never needs a follow-up read to
	 * show its own effect: the page updates the instant the host answers.
	 *
	 * @param {(sessionId: string) => Promise<object>} operation - the call.
	 * @param {object} [options] - reporting options.
	 * @param {string | ((result: object) => string)} [options.note] - a message to
	 *   show on success, or a function of the response when what to say depends on
	 *   it — a confirm that reports warnings reads differently from one that did not.
	 * @returns {Promise<object | undefined>} the host's response.
	 */
	const act = React.useCallback(
		async (operation, options = {}) => {
			if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
			setBusy(true);
			setActionError('');
			setActionNote('');
			try {
				const result = await operation(sessionId);
				if (result !== null && typeof result === 'object' && result.state !== undefined) setState(result.state);
				const note = typeof options.note === 'function' ? options.note(result) : options.note;
				if (typeof note === 'string' && note.length > 0) setActionNote(note);
				return result;
			} catch (error) {
				setActionError(error instanceof Error ? error.message : String(error));
				return undefined;
			} finally {
				setBusy(false);
			}
		},
		[sessionId],
	);

	return {
		state,
		loadError,
		actionError,
		actionNote,
		busy,
		reload,
		act,
		clearActionError: React.useCallback(() => setActionError(''), []),
		clearActionNote: React.useCallback(() => setActionNote(''), []),
	};
}
		//#endregion

		//#region src/30-styles.js
/**
 * The page stylesheet.
 *
 * Every colour comes from a `--dsw-*` theme token. That is not a stylistic
 * preference: the same page has to read correctly in the light and the dark
 * theme, and a raw hex value is exactly the thing that works in one and becomes
 * unreadable in the other.
 *
 * One `<style>` element is inserted per document and keyed by a marker attribute,
 * so hot-reloading the plugin twice does not accumulate copies.
 */

/** The marker that identifies this plugin's stylesheet. */
const STYLE_MARKER = 'data-dsh-spec-loop-style';

/** The stylesheet text. */
const STYLESHEET = `
.sl-root {
	display: flex;
	flex-direction: column;
	gap: 16px;
	height: 100%;
	min-height: 0;
	overflow: auto;
	padding: 16px 20px 40px;
	box-sizing: border-box;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-base);
	font-size: 13px;
	line-height: 1.6;
}

.sl-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.sl-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sl-title { font-size: 17px; font-weight: 600; }
.sl-subtitle { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.sl-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.sl-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.sl-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46ch; }

.sl-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sl-row-end { margin-left: auto; }

.sl-btn {
	appearance: none;
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-1);
	color: var(--dsw-alias-label-primary);
	border-radius: 7px;
	padding: 4px 11px;
	font-size: 12px;
	line-height: 1.7;
	cursor: pointer;
	font-family: inherit;
	white-space: nowrap;
}
.sl-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.sl-btn:disabled { opacity: 0.5; cursor: default; }
.sl-btn-primary {
	background: var(--dsw-alias-brand-primary);
	border-color: var(--dsw-alias-brand-primary);
	color: var(--dsw-alias-bg-base);
	font-weight: 600;
}
.sl-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); opacity: 0.9; }
.sl-btn-quiet { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.sl-btn-quiet:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }

.sl-card {
	border: 1px solid var(--dsw-alias-border-l1);
	background: var(--dsw-alias-bg-layer-1);
	border-radius: 11px;
	padding: 14px 16px;
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.sl-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.sl-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }

.sl-textarea {
	width: 100%;
	box-sizing: border-box;
	min-height: 96px;
	max-height: 320px;
	resize: vertical;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 8px;
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
	padding: 9px 11px;
	font-family: inherit;
	font-size: 13px;
	line-height: 1.6;
}
.sl-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }

.sl-input {
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 7px;
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
	padding: 4px 8px;
	font-family: inherit;
	font-size: 12.5px;
}
.sl-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.sl-input-num { width: 68px; }
.sl-input-wide { width: 100%; box-sizing: border-box; }

.sl-pill {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	border-radius: 999px;
	padding: 1px 9px;
	font-size: 11.5px;
	font-weight: 600;
	border: 1px solid transparent;
	white-space: nowrap;
}
.sl-pill::before {
	content: '';
	width: 6px;
	height: 6px;
	border-radius: 999px;
	background: currentColor;
	flex: none;
}
.sl-tone-idle { color: var(--dsw-alias-state-idle-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.sl-tone-busy { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.sl-tone-ok { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.sl-tone-warn { color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.sl-tone-error { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }

.sl-list { display: flex; flex-direction: column; gap: 10px; }
.sl-change { display: flex; flex-direction: column; gap: 9px; }
.sl-change-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.sl-change-id { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.sl-change-title { color: var(--dsw-alias-label-secondary); font-size: 12px; min-width: 0; }
.sl-change-summary { color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: pre-wrap; }
.sl-change-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.sl-bar { height: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.sl-bar-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width 240ms ease; }
.sl-bar-fill-ok { background: var(--dsw-alias-state-success-primary); }

.sl-details { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 9px; display: flex; flex-direction: column; gap: 8px; }
.sl-log { display: flex; flex-direction: column; gap: 6px; }
.sl-log-entry {
	border-left: 2px solid var(--dsw-alias-border-l2);
	padding: 3px 0 3px 9px;
	display: flex;
	flex-direction: column;
	gap: 2px;
}
.sl-log-entry-error { border-left-color: var(--dsw-alias-state-error-primary); }
.sl-log-entry-ok { border-left-color: var(--dsw-alias-state-success-primary); }
.sl-log-entry-warn { border-left-color: var(--dsw-alias-state-warn-primary); }
.sl-log-head { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.sl-log-note { color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: pre-wrap; word-break: break-word; }

.sl-notice {
	border-radius: 9px;
	padding: 9px 12px;
	font-size: 12.5px;
	border: 1px solid var(--dsw-alias-border-l1);
	background: var(--dsw-alias-bg-layer-2);
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
}
.sl-notice-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.sl-notice-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.sl-notice-ok { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }

.sl-settings-grid { display: grid; grid-template-columns: auto 1fr; gap: 10px 14px; align-items: start; }
.sl-settings-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.sl-checkbox { display: flex; align-items: center; gap: 7px; }

.sl-spinner {
	display: inline-block;
	width: 11px;
	height: 11px;
	border: 2px solid var(--dsw-alias-border-l2);
	border-top-color: var(--dsw-alias-brand-primary);
	border-radius: 999px;
	animation: sl-spin 700ms linear infinite;
	flex: none;
}
@keyframes sl-spin { to { transform: rotate(360deg); } }

.sl-empty { color: var(--dsw-alias-label-secondary); font-size: 12.5px; padding: 18px 4px; text-align: center; }

.sl-code {
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 12px;
	padding: 1px 5px;
	border-radius: 5px;
	background: var(--dsw-alias-bg-layer-2);
	border: 1px solid var(--dsw-alias-border-l1);
	color: var(--dsw-alias-label-primary);
}
.sl-copy { margin: 0; font-size: 12.5px; color: var(--dsw-alias-label-secondary); display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }

.sl-proposal { display: flex; flex-direction: column; gap: 7px; padding: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); }
.sl-proposal-off { opacity: 0.55; }
.sl-proposal-head { display: flex; align-items: center; gap: 8px; }
.sl-proposal-title { flex: 1; min-width: 0; font-weight: 600; }
.sl-proposal-summary { min-height: 38px; font-size: 12px; resize: vertical; font-family: inherit; }
.sl-proposal-id { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.sl-check { width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary); flex: none; cursor: pointer; }

.sl-tasks { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sl-tasks code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; margin-right: 4px; color: var(--dsw-alias-label-primary); }

.sl-artifacts { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 9px; }
.sl-artifacts section { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.sl-pre {
	margin: 0;
	padding: 9px;
	max-height: 320px;
	overflow: auto;
	border-radius: 7px;
	background: var(--dsw-alias-bg-layer-2);
	border: 1px solid var(--dsw-alias-border-l1);
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 11.5px;
	line-height: 1.5;
	white-space: pre-wrap;
	word-break: break-word;
	color: var(--dsw-alias-label-primary);
}

@media (prefers-reduced-motion: reduce) {
	.sl-bar-fill { transition: none; }
	.sl-spinner { animation-duration: 2s; }
}
`;

/**
 * Insert the stylesheet once per document.
 * @returns {() => void} a disposer that removes it.
 */
function installStyles() {
	if (typeof document === 'undefined') return () => {};
	const existing = document.querySelector(`style[${STYLE_MARKER}]`);
	if (existing !== null) return () => {};
	const style = document.createElement('style');
	style.setAttribute(STYLE_MARKER, '');
	style.textContent = STYLESHEET;
	document.head.appendChild(style);
	return () => {
		style.remove();
	};
}
		//#endregion

		//#region src/40-page.js
/**
 * The page itself.
 *
 * Layout is a header, a requirement composer, then the change list, with the
 * settings panel replacing the list rather than floating over it: this page owns
 * a whole conversation tab, so there is room to be plain about what is on screen.
 */

/**
 * A small status pill.
 * @param {object} props - `t` and the status.
 * @returns {object} the element.
 */
function StatusPill({ t, status }) {
	return h('span', { className: `sl-pill sl-tone-${toneOf(status)}` }, t(`status.${status}`));
}

/**
 * A thin progress bar with an accessible label.
 * @param {object} props - `done`, `total`, and the label.
 * @returns {object} the element.
 */
function ProgressBar({ done, total, label }) {
	const value = percent(done, total);
	return h(
		'div',
		{
			className: 'sl-bar',
			role: 'progressbar',
			'aria-valuemin': 0,
			'aria-valuemax': 100,
			'aria-valuenow': value,
			'aria-label': label,
		},
		h('div', {
			className: `sl-bar-fill${value >= 100 && total > 0 ? ' sl-bar-fill-ok' : ''}`,
			style: { width: `${value}%` },
		}),
	);
}

/**
 * A notice line.
 * @param {object} props - `tone` and children.
 * @returns {object} the element.
 */
function Notice({ tone, children }) {
	return h('div', { className: `sl-notice${tone ? ` sl-notice-${tone}` : ''}` }, children);
}

/**
 * Render one round-log entry.
 * @param {object} props - `t` and the entry.
 * @returns {object} the element.
 */
function LogEntry({ t, entry }) {
	const kind = entry.kind === 'split' ? t('log.split') : `${t('log.ralph')} #${entry.round}`;
	const tone =
		entry.status === 'ok' ? 'ok' : entry.status === 'error' ? 'error' : entry.status === 'timeout' ? 'warn' : '';
	return h(
		'div',
		{ className: `sl-log-entry${tone ? ` sl-log-entry-${tone}` : ''}` },
		h(
			'div',
			{ className: 'sl-log-head' },
			h('strong', null, kind),
			entry.status === 'ok' || entry.kind === 'split' ? null : h('span', { className: 'sl-hint' }, t(`log.${entry.status}`)),
			entry.kind === 'split'
				? null
				: h('span', { className: 'sl-hint' }, `${entry.tasksDone}/${entry.tasksTotal}`),
			h('span', { className: 'sl-hint sl-row-end' }, formatClock(entry.finishedAt || entry.startedAt)),
		),
		entry.note ? h('div', { className: 'sl-log-note' }, entry.note) : null,
	);
}

/**
 * One change card: status, progress, the actions that apply to it, and its log.
 * @param {object} props - `t`, `sessionId`, `change`, `loop`, the open state, and
 *   the session-navigation pair `openSession` / `canOpenSession`.
 * @returns {object} the element.
 */
function ChangeCard({ t, sessionId, change, loop, open, onToggle, openSession, canOpenSession }) {
	const [roundsDraft, setRoundsDraft] = React.useState(null);
	const [confirming, setConfirming] = React.useState(false);
	const [copied, setCopied] = React.useState(false);
	// Asked on every render rather than latched: the shell may gain the workspace
	// domain after this card first painted.
	const canJump = typeof canOpenSession === 'function' && canOpenSession() === true;

	const roundsValue = roundsDraft ?? String(change.maxIterations);
	const roundsDirty = roundsDraft !== null && Number.parseInt(roundsDraft, 10) !== change.maxIterations;
	const active = change.active === true;
	const done = change.status === 'done';
	const parked = change.status === 'queued';

	const saveRounds = () => {
		const value = Number.parseInt(roundsValue, 10);
		if (!Number.isFinite(value)) {
			setRoundsDraft(null);
			return;
		}
		void loop.act((id) => api.update(id, change.id, { maxIterations: value })).then(() => setRoundsDraft(null));
	};

	const copySession = () => {
		try {
			void navigator.clipboard?.writeText(change.sessionId);
			setCopied(true);
			setTimeout(() => setCopied(false), 1400);
		} catch {
			/* A clipboard that refuses simply does not confirm. */
		}
	};

	/**
	 * Reveal the session this change's rounds run in.
	 *
	 * Opening is the point of the chip — a round is an ordinary conversation and
	 * watching it is how you tell "working" from "stuck". Copying is only the
	 * fallback for a shell with no session navigation, so that the id is never
	 * stranded in a tooltip the way it was when this only copied.
	 */
	const revealSession = () => {
		if (canJump && typeof openSession === 'function') {
			if (openSession(change.sessionId) === true) return;
		}
		copySession();
	};

	return h(
		'div',
		{ className: 'sl-card sl-change' },
		h(
			'div',
			{ className: 'sl-change-head' },
			h('span', { className: 'sl-change-id' }, change.id),
			h(StatusPill, { t, status: change.status }),
			h(
				'span',
				{ className: 'sl-hint' },
				change.tasksTotal > 0
					? t('card.tasks', { done: change.tasksDone, total: change.tasksTotal })
					: t('card.noTasks'),
			),
			h('span', { className: 'sl-hint' }, t('card.iterations', { done: change.iterations, max: change.maxIterations })),
			active ? h('span', { className: 'sl-spinner' }) : null,
			h('span', { className: 'sl-hint sl-row-end' }, t('card.updatedAt', { time: formatRelative(change.updatedAt, t) })),
		),
		h(ProgressBar, {
			done: change.tasksDone,
			total: change.tasksTotal,
			label: t('card.tasks', { done: change.tasksDone, total: change.tasksTotal }),
		}),
		change.title || change.summary
			? h(
					'div',
					{ className: 'sl-change-title' },
					change.title ? h('div', null, change.title) : null,
					change.summary ? h('div', { className: 'sl-change-summary' }, clip(change.summary, 400)) : null,
				)
			: null,
		change.error ? h(Notice, { tone: 'error' }, change.error) : null,
		change.note ? h(Notice, { tone: change.status === 'done' ? 'ok' : 'warn' }, change.note) : null,
		h(
			'div',
			{ className: 'sl-change-actions' },
			active
				? h(
						'button',
						{ type: 'button', className: 'sl-btn', disabled: loop.busy, onClick: () => void loop.act((id) => api.stop(id, change.id), { note: `已停止 ${change.id}` }) },
						t('card.stop'),
					)
				: h(
						'button',
						{
							type: 'button',
							className: 'sl-btn sl-btn-primary',
							disabled: loop.busy,
							onClick: () => void loop.act((id) => api.run(id, change.id)),
						},
						done ? t('card.retry') : change.iterations > 0 ? t('card.continue') : t('card.start'),
					),
			active || parked
				? null
				: h(
						'label',
						{ className: 'sl-row', title: t('card.rounds') },
						h('span', { className: 'sl-hint' }, t('card.rounds')),
						h('input', {
							className: 'sl-input sl-input-num',
							type: 'number',
							min: 1,
							max: 50,
							value: roundsValue,
							onChange: (event) => setRoundsDraft(event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'Enter') saveRounds();
							},
						}),
						roundsDirty
							? h('button', { type: 'button', className: 'sl-btn', disabled: loop.busy, onClick: saveRounds }, t('card.roundsSave'))
							: null,
					),
			change.sessionId
				? h(
						'button',
						{
							type: 'button',
							className: 'sl-btn sl-btn-quiet sl-mono',
							// Say which of the two actions this click will take. A tooltip that
							// promises a jump and performs a copy is worse than no tooltip.
							title: canJump
								? `${t('card.openSession')}: ${change.sessionId}`
								: `${t('card.copySession')}: ${change.sessionId}`,
							onClick: revealSession,
						},
						copied ? '✓' : `${canJump ? '▶' : '◈'} ${shortSessionId(change.sessionId)}`,
					)
				: null,
			h(
				'button',
				{ type: 'button', className: 'sl-btn sl-btn-quiet sl-row-end', onClick: () => onToggle(change.id) },
				open ? t('card.hideDetails') : t('card.details'),
			),
		),
		open
			? h(
					'div',
					{ className: 'sl-details' },
					change.log && change.log.length > 0
						? h('div', { className: 'sl-log' }, ...[...change.log].reverse().map((entry, index) => h(LogEntry, { t, entry, key: `${entry.round}-${index}` })))
						: h('div', { className: 'sl-hint' }, t('card.logEmpty')),
					change.validation
						? h(
								'div',
								{ className: 'sl-settings-field' },
								h('span', { className: 'sl-label' }, t('card.validation')),
								h('pre', { className: 'sl-log-note sl-mono' }, clip(change.validation, 2000)),
							)
						: null,
					h(
						'div',
						{ className: 'sl-row' },
						confirming
							? h(
									'div',
									{ className: 'sl-row' },
									h('span', { className: 'sl-hint' }, t('card.deleteHint')),
									h(
										'button',
										{
											type: 'button',
											className: 'sl-btn',
											disabled: loop.busy,
											onClick: () => {
												setConfirming(false);
												void loop.act((id) => api.remove(id, change.id), { note: `已从列表移除 ${change.id}` });
											},
										},
										t('card.deleteConfirm'),
									),
									h('button', { type: 'button', className: 'sl-btn sl-btn-quiet', onClick: () => setConfirming(false) }, '×'),
								)
							: h(
									'button',
									{
										type: 'button',
										className: 'sl-btn sl-btn-quiet',
										disabled: active,
										onClick: () => setConfirming(true),
									},
									t('card.delete'),
								),
					),
				)
			: null,
	);
}

/**
 * The settings panel.
 * @param {object} props - `t`, `loop`, `settings`, and `onClose`.
 * @returns {object} the element.
 */
function SettingsPanel({ t, loop, settings, onClose }) {
	const [draft, setDraft] = React.useState(settings);
	React.useEffect(() => setDraft(settings), [settings]);
	if (draft === null || draft === undefined) return null;
	/** Patch one field of the draft. */
	const set = (patch) => setDraft({ ...draft, ...patch });
	/** One numeric field. */
	const number = (key, min, max) =>
		h('input', {
			className: 'sl-input sl-input-num',
			type: 'number',
			min,
			max,
			value: draft[key],
			onChange: (event) => set({ [key]: Number.parseInt(event.target.value, 10) }),
		});
	return h(
		'div',
		{ className: 'sl-card' },
		h(
			'div',
			{ className: 'sl-row' },
			h('span', { className: 'sl-title' }, t('settings.title')),
			h('button', { type: 'button', className: 'sl-btn sl-btn-quiet sl-row-end', onClick: onClose }, t('settings.close')),
		),
		h(
			'div',
			{ className: 'sl-settings-grid' },
			h('span', { className: 'sl-label' }, t('settings.defaultRounds')),
			h(
				'div',
				{ className: 'sl-settings-field' },
				number('ralphIterations', 1, 50),
				h('span', { className: 'sl-hint' }, t('settings.defaultRoundsHint')),
			),
			h('span', { className: 'sl-label' }, t('settings.concurrency')),
			h(
				'div',
				{ className: 'sl-settings-field' },
				number('concurrency', 1, 8),
				h('span', { className: 'sl-hint' }, t('settings.concurrencyHint')),
			),
			h('span', { className: 'sl-label' }, t('settings.timeout')),
			h(
				'div',
				{ className: 'sl-settings-field' },
				number('iterationTimeoutMinutes', 1, 1440),
				h('span', { className: 'sl-hint' }, t('settings.timeoutHint')),
			),
			h('span', { className: 'sl-label' }, t('settings.stall')),
			h(
				'div',
				{ className: 'sl-settings-field' },
				number('stallLimit', 1, 20),
				h('span', { className: 'sl-hint' }, t('settings.stallHint')),
			),
			h('span', { className: 'sl-label' }, t('settings.autoApprove')),
			h(
				'label',
				{ className: 'sl-checkbox' },
				h('input', {
					type: 'checkbox',
					checked: draft.autoApprove === true,
					onChange: (event) => set({ autoApprove: event.target.checked }),
				}),
				h('span', { className: 'sl-hint' }, t('settings.autoApproveHint')),
			),
			h('span', { className: 'sl-label' }, t('settings.command')),
			h(
				'div',
				{ className: 'sl-settings-field' },
				h('input', {
					className: 'sl-input sl-input-wide',
					type: 'text',
					value: draft.openspecCommand,
					onChange: (event) => set({ openspecCommand: event.target.value }),
				}),
				h('span', { className: 'sl-hint' }, t('settings.commandHint')),
			),
		),
		h(
			'div',
			{ className: 'sl-row' },
			h(
				'button',
				{
					type: 'button',
					className: 'sl-btn sl-btn-primary',
					disabled: loop.busy,
					onClick: () => void loop.act((id) => api.saveSettings(id, draft), { note: t('settings.saved') }),
				},
				t('settings.save'),
			),
		),
	);
}

/**
 * One proposed change, as the user reviews it.
 *
 * The title and summary are inputs because those are the two things a user
 * actually wants to correct before saying yes — an id they dislike, a summary
 * that missed the point. The task list is rendered read-only for the same reason
 * it is generated rather than pasted: it is what the loop counts, and a plan
 * whose tally had been hand-edited behind the agent's back would make the first
 * round's progress unexplainable.
 *
 * @param {object} props - `t`, `sessionId`, `entry`, and the edit callbacks.
 * @returns {object} the element.
 */
function ProposalEntry({ t, sessionId, entry, onToggle, onEdit }) {
	const [detail, setDetail] = React.useState(null);
	const [detailError, setDetailError] = React.useState('');
	const [loading, setLoading] = React.useState(false);
	const included = entry.include !== false;

	const edit = (patch) => onEdit(entry.id, patch);

	/** Load the full artifacts on demand, and cache them on the component. */
	const toggleDetail = () => {
		if (detail !== null) {
			setDetail(null);
			return;
		}
		setLoading(true);
		setDetailError('');
		api
			.fetchEntry(sessionId, entry.id)
			.then((body) => setDetail(body))
			.catch((error) => setDetailError(error instanceof Error ? error.message : String(error)))
			.finally(() => setLoading(false));
	};

	const specs = entry.specs ?? [];
	return h(
		'div',
		{ className: `sl-proposal${included ? '' : ' sl-proposal-off'}` },
		h(
			'div',
			{ className: 'sl-proposal-head' },
			h('input', {
				type: 'checkbox',
				className: 'sl-check',
				checked: included,
				'aria-label': t('proposal.include'),
				onChange: (event) => onToggle(entry.id, event.target.checked),
			}),
			h('input', {
				className: 'sl-input sl-proposal-title',
				type: 'text',
				value: entry.title,
				disabled: !included,
				'aria-label': t('proposal.title'),
				onChange: (event) => edit({ title: event.target.value }),
			}),
			h(
				'span',
				{ className: 'sl-hint sl-row-end' },
				entry.tasksTotal > 0 ? t('proposal.tasks', { count: entry.tasksTotal }) : t('proposal.noTasks'),
			),
		),
		h('code', { className: 'sl-proposal-id' }, entry.id),
		h('textarea', {
			className: 'sl-textarea sl-proposal-summary',
			value: entry.summary,
			disabled: !included,
			rows: 2,
			'aria-label': t('discuss.title'),
			onChange: (event) => edit({ summary: event.target.value }),
		}),
		specs.length > 0
			? h('span', { className: 'sl-hint' }, t('proposal.specs', { list: specs.join(', ') }))
			: h('span', { className: 'sl-hint' }, t('proposal.noSpecs')),

		// The lint result is the review step earning its keep: a plan that would be
		// rejected by `openspec validate` is visible *before* the user confirms,
		// instead of surfacing afterwards as a broken change.
		(entry.problems ?? []).length > 0
			? h(Notice, { tone: 'warn' }, t('proposal.problems', { list: entry.problems.join('；') }))
			: null,

		entry.tasksTotal > 0
			? h(
					'ul',
					{ className: 'sl-tasks' },
					...(entry.tasks ?? []).slice(0, 12).map((task) =>
						h('li', { key: task.id }, h('code', null, task.id), ` ${task.description}`),
					),
				)
			: null,

		h(
			'div',
			{ className: 'sl-row' },
			h(
				'button',
				{ type: 'button', className: 'sl-btn sl-btn-quiet', onClick: toggleDetail },
				detail === null ? t('proposal.detail') : t('proposal.hideDetail'),
			),
			loading ? h('span', { className: 'sl-spinner' }) : null,
		),
		detailError.length > 0 ? h(Notice, { tone: 'error' }, t('proposal.detailFailed', { message: detailError })) : null,
		detail !== null
			? h(
					'div',
					{ className: 'sl-artifacts' },
					...['proposal', 'design', 'tasks'].map((key) =>
						detail[key]
							? h(
									'section',
									{ key },
									h('span', { className: 'sl-label' }, `${key}.md`),
									h('pre', { className: 'sl-pre' }, detail[key]),
								)
							: null,
					),
					...(detail.specs ?? []).map((spec) =>
						h(
							'section',
							{ key: spec.capability },
							h('span', { className: 'sl-label' }, `specs/${spec.capability}/spec.md`),
							h('pre', { className: 'sl-pre' }, spec.content),
						),
					),
				)
			: null,
	);
}

/**
 * The pending plan: what will be created, once the user says so.
 *
 * @param {object} props - `t`, `sessionId`, `loop`, and the discussion.
 * @returns {object} the element.
 */
function ProposalPanel({ t, sessionId, loop, discussion }) {
	const proposal = discussion.proposal;
	const entries = proposal.entries ?? [];
	// The host always sends `dropped`, but a page that throws on a snapshot it did
	// not expect is a page with a blank tab instead of an explanation.
	const dropped = proposal.dropped ?? [];
	const selected = entries.filter((entry) => entry.include !== false);
	const [confirming, setConfirming] = React.useState(false);

	/** Fold one edited field back into the host's copy of the draft. */
	const onEdit = (id, patch) => {
		void loop.act((session) => api.updateDraft(session, { [id]: patch }));
	};
	const onToggle = (id, include) => onEdit(id, { include });

	const confirm = () => {
		setConfirming(true);
		void loop
			.act((session) => api.applyDraft(session), {
				// What there is to say depends on the answer: a clean creation and one
				// that came back with warnings are different outcomes to the user.
				note: (result) => {
					const warnings = result.warnings ?? [];
					return warnings.length > 0
						? t('proposal.createdWarnings', { list: warnings.join('；') })
						: t('proposal.created', { count: (result.ids ?? []).length });
				},
			})
			.finally(() => setConfirming(false));
	};

	return h(
		'div',
		{ className: 'sl-card' },
		h(
			'div',
			{ className: 'sl-row' },
			h('span', { className: 'sl-label' }, t('proposal.title')),
			h('span', { className: 'sl-hint' }, t('proposal.count', { total: entries.length, selected: selected.length })),
		),
		dropped.length > 0
			? h(
					'div',
					{ className: 'sl-log' },
					h('span', { className: 'sl-hint' }, t('proposal.dropped', { count: dropped.length })),
					...dropped.map((entry, index) =>
						h('div', { className: 'sl-log-note', key: index }, `· ${entry.id ?? '?'}：${entry.reason}`),
					),
				)
			: null,
		h(
			'div',
			{ className: 'sl-list' },
			...entries.map((entry) =>
				h(ProposalEntry, { key: entry.id, t, sessionId, entry, onToggle, onEdit }),
			),
		),
		h('span', { className: 'sl-hint' }, t('proposal.confirmHint')),
		h(
			'div',
			{ className: 'sl-row' },
			h(
				'button',
				{ type: 'button', className: 'sl-btn sl-btn-primary', disabled: loop.busy || selected.length === 0, onClick: confirm },
				confirming ? t('proposal.confirming') : t('proposal.confirm', { count: selected.length }),
			),
			h(DiscardButton, { t, loop }),
		),
	);
}

/**
 * The discard button, with its one-step confirmation.
 * @param {object} props - `t` and `loop`.
 * @returns {object} the element.
 */
function DiscardButton({ t, loop }) {
	const [confirming, setConfirming] = React.useState(false);
	if (!confirming) {
		return h(
			'button',
			{
				type: 'button',
				className: 'sl-btn sl-btn-quiet sl-row-end',
				title: t('discuss.discardHint'),
				disabled: loop.busy,
				onClick: () => setConfirming(true),
			},
			t('discuss.discard'),
		);
	}
	return h(
		'span',
		{ className: 'sl-row sl-row-end' },
		h('span', { className: 'sl-hint' }, t('discuss.discardHint')),
		h(
			'button',
			{
				type: 'button',
				className: 'sl-btn',
				onClick: () => {
					setConfirming(false);
					void loop.act((session) => api.discardDraft(session), { note: t('discuss.discarded') });
				},
			},
			t('discuss.discardConfirm'),
		),
		h('button', { type: 'button', className: 'sl-btn sl-btn-quiet', onClick: () => setConfirming(false) }, '×'),
	);
}

/**
 * What the page shows when there is no discussion: how to start one.
 *
 * The command line is the only entry point — there is no textarea here on
 * purpose. A requirement typed into this panel would open a discussion the user
 * could not continue, because the conversation happens in the composer, and a
 * second, half-working way in is worse than none. So the panel states the
 * command, offers it on the clipboard, and gets out of the way.
 *
 * @param {object} props - `t`.
 * @returns {object} the element.
 */
function CommandHint({ t }) {
	const [copied, setCopied] = React.useState(false);
	const copy = () => {
		try {
			void navigator.clipboard?.writeText('/spec ');
			setCopied(true);
			setTimeout(() => setCopied(false), 1400);
		} catch {
			/* A clipboard that refuses simply does not confirm. */
		}
	};
	return h(
		'div',
		{ className: 'sl-card' },
		h('span', { className: 'sl-label' }, t('discuss.title')),
		h(
			'div',
			{ className: 'sl-row' },
			h(
				'p',
				{ className: 'sl-copy' },
				t('discuss.hintBefore'),
				h('code', { className: 'sl-code' }, '/spec'),
				t('discuss.hintAfter'),
			),
			h(
				'button',
				{ type: 'button', className: 'sl-btn sl-row-end', onClick: copy },
				copied ? t('discuss.copied') : t('discuss.copy'),
			),
		),
		h('span', { className: 'sl-hint' }, t('discuss.howItWorks')),
	);
}

/**
 * The discussion in progress: the requirement, and the plan when there is one.
 *
 * @param {object} props - `t`, `sessionId`, `loop`, and the discussion.
 * @returns {object} the element.
 */
function DiscussionPanel({ t, sessionId, loop, discussion }) {
	const proposed = discussion.status === 'proposed' && discussion.proposal !== null;
	const [asking, setAsking] = React.useState(false);

	const askForPlan = () => {
		setAsking(true);
		void loop
			.act((session) => api.planDraft(session), { note: t('discuss.planSent') })
			.finally(() => setAsking(false));
	};

	return h(
		'div',
		{ className: 'sl-card' },
		h(
			'div',
			{ className: 'sl-row' },
			h('span', { className: 'sl-label' }, t('discuss.title')),
			h(
				'span',
				{ className: `sl-pill sl-tone-${proposed ? 'ok' : 'busy'}` },
				proposed ? t('discuss.status.proposed') : t('discuss.status.discussing'),
			),
			!proposed ? h('span', { className: 'sl-spinner' }) : null,
			h(
				'button',
				{ type: 'button', className: 'sl-btn sl-btn-quiet sl-row-end', disabled: loop.busy || asking, onClick: askForPlan },
				asking ? t('proposal.confirming') : t('discuss.plan'),
			),
		),
		h('span', { className: 'sl-label' }, t('discuss.requirement')),
		h('div', { className: 'sl-change-summary' }, discussion.requirement),
		proposed ? null : h('span', { className: 'sl-hint' }, t('discuss.howItWorks')),
		proposed
			? h(ProposalPanel, { t, sessionId, loop, discussion })
			: h(
					'div',
					{ className: 'sl-row' },
					h(
						'span',
						{ className: 'sl-hint' },
						h('code', { className: 'sl-code' }, '/spec plan'),
						' · ',
						h('code', { className: 'sl-code' }, '/spec cancel'),
					),
					h(DiscardButton, { t, loop }),
				),
	);
}

/**
 * The page body, given a snapshot.
 *
 * Split out from the page because the polling lives in an effect, and effects do
 * not run in a server render: rendering `SpecLoopPage` directly can only ever
 * reach its loading state, which would leave the loaded page — the part with the
 * discussion, the plan and the change list — unrendered by every test. This takes
 * the snapshot as a prop instead, so a test can put the page in any state at all.
 *
 * @param {object} props - `t`, `sessionId`, `loop`, the current snapshot, and the
 *   session-navigation pair handed down to every card.
 * @returns {object} the element.
 */
function SpecLoopView({ t, sessionId, loop, state, openSession, canOpenSession }) {
	const [showSettings, setShowSettings] = React.useState(false);
	const [openIds, setOpenIds] = React.useState({});

	const openspec = state?.openspec ?? null;
	const changes = state?.changes ?? [];
	const discussion = state?.discussion ?? null;
	// A discussion counts as work in flight: the agent is thinking between turns,
	// and every control that starts or changes something has to stay off until it
	// settles, or a click would race the next turn.
	const working = changes.some((change) => change.active === true) || discussion !== null;

	/** Toggle one card's details. */
	const toggleDetails = (id) => setOpenIds((current) => ({ ...current, [id]: current[id] !== true }));

	if (state === null) {
		return h(
			'div',
			{ className: 'sl-root' },
			loop.loadError.length > 0
				? h(Notice, { tone: 'error' }, t('state.loadFailed', { message: loop.loadError }))
				: h(Notice, null, h('span', { className: 'sl-spinner' }), t('state.loading')),
		);
	}

	return h(
		'div',
		{ className: 'sl-root' },
		h(
			'div',
			{ className: 'sl-header' },
			h(
				'div',
				{ className: 'sl-titles' },
				h('span', { className: 'sl-title' }, t('page.title')),
				h('span', { className: 'sl-subtitle' }, t('page.subtitle')),
			),
			h(
				'div',
				{ className: 'sl-meta' },
				state.projectPath
					? h('span', { className: 'sl-mono sl-truncate', title: state.projectPath }, state.projectPath)
					: null,
				h(
					'button',
					{ type: 'button', className: 'sl-btn sl-btn-quiet', disabled: loop.busy, onClick: () => loop.reload() },
					t('list.refresh'),
				),
				h(
					'button',
					{ type: 'button', className: 'sl-btn sl-btn-quiet', onClick: () => setShowSettings((value) => !value) },
					t('list.settings'),
				),
			),
		),

		state.loadError ? h(Notice, { tone: 'warn' }, t('state.stale', { message: state.loadError })) : null,
		loop.loadError.length > 0 ? h(Notice, { tone: 'error' }, t('state.loadFailed', { message: loop.loadError })) : null,
		loop.actionError.length > 0 ? h(Notice, { tone: 'error' }, t('action.failed', { message: loop.actionError })) : null,
		loop.actionNote.length > 0 ? h(Notice, { tone: 'ok' }, loop.actionNote) : null,

		state.projectPath === null ? h(Notice, { tone: 'warn' }, t('state.noProject')) : null,

		openspec !== null && openspec.available !== true ? h(Notice, { tone: 'error' }, t('state.noOpenspec')) : null,

		openspec !== null && openspec.available === true && openspec.initialized !== true
			? h(
					Notice,
					{ tone: 'warn' },
					t('state.notInitialized'),
					h(
						'button',
						{
							type: 'button',
							className: 'sl-btn sl-btn-primary',
							disabled: loop.busy,
							onClick: () => void loop.act((id) => api.init(id)),
						},
						loop.busy ? t('init.running') : t('init.button'),
					),
				)
			: null,

		showSettings
			? h(SettingsPanel, { t, loop, settings: state.settings, onClose: () => setShowSettings(false) })
			: discussion === null
				? h(CommandHint, { t })
				: h(DiscussionPanel, { t, sessionId, loop, discussion }),

		h(
			'div',
			{ className: 'sl-row' },
			h('span', { className: 'sl-label' }, t('list.title')),
			h('span', { className: 'sl-hint' }, t('list.count', { count: changes.length })),
			h(
				'button',
				{
					type: 'button',
					className: 'sl-btn sl-row-end',
					disabled: loop.busy || changes.length === 0,
					title: t('list.importedNote'),
					onClick: () => void loop.act((id) => api.runAll(id)),
				},
				t('list.runAll'),
			),
		),

		changes.length === 0
			? h('div', { className: 'sl-empty' }, t('list.empty'))
			: h(
					'div',
					{ className: 'sl-list' },
					...changes.map((change) =>
						h(ChangeCard, {
							key: change.id,
							t,
							sessionId,
							change,
							loop,
							open: openIds[change.id] === true,
							onToggle: toggleDetails,
							openSession,
							canOpenSession,
						}),
					),
				),

		working ? h('div', { className: 'sl-row' }, h('span', { className: 'sl-spinner' })) : null,
	);
}

/**
 * The page, with its polling.
 * @param {object} props - `t` from the locale namespace, `sessionId` from the slot.
 * @returns {object} the element.
 */
function SpecLoopPage({ t, sessionId, openSession, canOpenSession }) {
	const loop = useLoopState(sessionId);
	return h(SpecLoopView, { t, sessionId, loop, state: loop.state, openSession, canOpenSession });
}
		//#endregion

		//#region src/90-plugin.js
/**
 * Plugin entry: dictionaries, the stylesheet, and the view registration.
 *
 * Registration layout: one entry in `conversation.view`, the session-scoped list
 * the shell renders one at a time. It already holds `chat` (order 0),
 * `trajectory` (order 10) and the task queue (order 20), so this takes order 30
 * and sits fourth — beside them rather than in either of their cells.
 *
 * Everything the page shows comes from the host half over one HTTP route, and
 * the page re-reads it on a poll. The truth — what a change's task tally is,
 * which rounds ran, what the round budget is — lives on the host, because a
 * browser tab is not a loop.
 */

/** Cordis client services this plugin's `apply` waits for. */
const inject = ['slots', 'locale'];

/**
 * Client plugin body.
 * @param {object} ctx - the client root context.
 */
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'spec-loop: dictionaries');
	ctx.effect(() => installStyles(), 'spec-loop: stylesheet');

	// Reading `uiWorkspace` optionally rather than injecting it is deliberate. It
	// is what turns a change's session chip into a jump to that session, and the
	// session is where you actually watch a round happen — but a shell without the
	// workspace domain should lose the jump, not the whole page. So the capability
	// is probed, and the chip falls back to copying the id.
	//
	// The probe is a function rather than a boolean read once here, because this
	// plugin declares only `slots` and `locale`: `ui-workspace` may well apply
	// *after* it, and a value captured now would pin the answer to whoever happened
	// to be first. Asking at render time instead makes the chip correct whenever it
	// is looked at, and the page re-renders on every poll.
	const workspace = () => ctx.get?.('uiWorkspace');
	const canOpenSession = () => typeof workspace()?.openSession === 'function';
	const openSession = (id) => {
		const ui = workspace();
		if (typeof ui?.openSession !== 'function') return false;
		try {
			ui.openSession(id);
			return true;
		} catch {
			// A navigation the shell refuses leaves the chip to its fallback.
			return false;
		}
	};

	// `label` is what the shell projects into the tab row; without it the tab would
	// read as the raw slot id. `inject` receives the session id, which is what makes
	// the page a *project's* page: the id travels with every request and the Host
	// resolves it to a directory, so the page never has to know — or be trusted
	// with — a path of its own.
	const label = ctx.locale.bind(NS);
	ctx.slots.inject('conversation.view', () =>
		ctx.slots.register(
			{
				name: 'conversation.view',
				id: VIEW_ID,
				order: 30,
				locale: NS,
				label: () => label('view.label'),
				inject: (sessionId) => ({ sessionId, openSession, canOpenSession }),
			},
			SpecLoopPage,
		),
	);
}
		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
