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
