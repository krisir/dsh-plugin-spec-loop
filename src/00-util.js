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
