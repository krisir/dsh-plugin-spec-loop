/**
 * The HTTP surface the page talks to.
 *
 * The browser half cannot call a third-party Host plugin through the generated
 * Remote protocol — the client side of that protocol has no source-mode
 * fallback, so it needs a build-time generated artifact this plugin does not
 * have. A plain route on `ctx.webServer` is the supported alternative, and it is
 * what the other third-party plugins in this profile do.
 *
 * Because such a route is reachable by anything that can open a loopback socket,
 * every mutating request is gated twice: it must come from loopback, and it must
 * be JSON. A web page the user visits cannot send a JSON POST without a preflight
 * the browser will refuse, and a non-loopback peer cannot reach the route at all
 * when the Host binds 127.0.0.1 — which is the default.
 *
 * Every request names the **session** it came from, and the Host resolves that
 * to a project directory. The page never sends a path: it does not know one, and
 * a client that named its own directory could aim the loop at any tree on the
 * machine.
 *
 * @module dsh-plugin-spec-loop/http
 */

import { DOCUMENT_VERSION, DRAFT_STATUS } from './state.js';
import { Openspec, changeIdsOnDisk } from './openspec.js';
import { renderPlanNudge } from './discourse.js';
import { ProposalError } from './proposal.js';
import { describeProposal } from './tool.js';

/** The route prefix this plugin owns exclusively. */
export const ROUTE_PREFIX = '/dsh-spec-loop/api';

/** Methods that change state, and therefore must be loopback and JSON. */
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The largest request body accepted, in bytes. */
const MAX_BODY = 256 * 1024;

/** The routes that are read with GET. */
const READ_ROUTES = new Set(['/state', '/', '/draft/entry']);

/** Every path that answers a POST. */
const WRITE_ROUTES = new Set([
	'/draft/update',
	'/draft/plan',
	'/draft/apply',
	'/draft/discard',
	'/changes/run',
	'/changes/runAll',
	'/changes/stop',
	'/changes/update',
	'/changes/delete',
	'/changes/refresh',
	'/settings',
	'/init',
]);

/**
 * Whether a socket address is the local machine.
 * @param {string | undefined} address - the peer address.
 * @returns {boolean} true for loopback (including IPv4-mapped IPv6).
 */
export function isLoopbackAddress(address) {
	if (typeof address !== 'string') return false;
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Whether a content type is JSON.
 * @param {unknown} value - the `content-type` header.
 * @returns {boolean} true when the body may be parsed as JSON.
 */
export function isJsonContentType(value) {
	if (typeof value !== 'string') return false;
	return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

/** Write a JSON response. */
function sendJson(res, status, body) {
	if (status === 204 || body === undefined) {
		res.writeHead(status);
		res.end();
		return;
	}
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(payload).toString(),
		'Cache-Control': 'no-store',
	});
	res.end(payload);
}

/** A stable error shape, so the page can show the message rather than guess. */
function errorBody(code, message) {
	return { error: { code, message } };
}

/** Read and parse a JSON request body. */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new Error('request body is too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8').trim();
			if (text.length === 0) {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(text);
				resolve(parsed !== null && typeof parsed === 'object' ? parsed : {});
			} catch {
				reject(new Error('request body is not valid JSON'));
			}
		});
		req.on('error', reject);
	});
}

/**
 * Build the request handler.
 *
 * @param {object} options - handler dependencies.
 * @param {object} options.store - the durable store.
 * @param {object} options.proposals - the proposal operations.
 * @param {object} options.sessions - the session seam, for the plan nudge.
 * @param {object} options.runner - the ralph loop runner.
 * @param {(sessionId: string) => string | undefined} options.projectOfSession - session → project directory.
 * @param {(projectPath: string) => string} options.commandFor - the configured CLI command.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @returns {(req: object, res: object) => Promise<void>} the route handler.
 */
export function createHandler({ store, proposals, sessions, runner, projectOfSession, commandFor, log = () => {} }) {
	/**
	 * The project directory a request came from, or undefined.
	 *
	 * Read through this rather than calling `projectOfSession` directly because a
	 * session that cannot be resolved is an expected state — a fresh session, a
	 * deleted one — and an exception thrown at a request boundary would be
	 * reported as a server fault instead of the 409 the page can explain.
	 */
	const projectFor = (sessionId) => {
		if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
		try {
			return projectOfSession(sessionId);
		} catch (error) {
			log(`could not resolve the project of ${sessionId}: ${String(error)}`);
			return undefined;
		}
	};

	/** The draft a request names, or undefined. */
	const draftFor = (sessionId) => store.draft(typeof sessionId === 'string' ? sessionId : '');

	/**
	 * The proposal entry a request names, or undefined.
	 * @param {string} sessionId - the session.
	 * @param {unknown} id - the entry id.
	 * @returns {object | undefined} the stored entry.
	 */
	const entryFor = (sessionId, id) => {
		const draft = draftFor(sessionId);
		if (typeof id !== 'string') return undefined;
		return draft?.proposal?.entries.find((entry) => entry.id === id);
	};

	/** The full snapshot the page renders from. */
	const snapshot = (projectPath, sessionId) => {
		const openspec =
			projectPath === undefined
				? { available: false, executable: undefined, root: undefined, initialized: false, command: '' }
				: { ...new Openspec({ projectPath, command: commandFor(projectPath) }).describe(), command: commandFor(projectPath) };
		const changes =
			projectPath === undefined
				? []
				: store.changes(projectPath).map((record) => ({
						...record,
						active: runner.isActive(projectPath, record.id),
						startable: !runner.isActive(projectPath, record.id),
					}));
		const draft = draftFor(sessionId);
		return {
			version: DOCUMENT_VERSION,
			now: Date.now(),
			projectPath: projectPath ?? null,
			openspec,
			settings: { ...store.settings() },
			changes,
			/** The requirement this session is discussing, and its pending plan. */
			discussion:
				draft === undefined
					? null
					: {
							status: draft.status,
							requirement: draft.requirement,
							projectPath: draft.projectPath,
							createdAt: draft.createdAt,
							updatedAt: draft.updatedAt,
							proposal: describeProposal(draft),
						},
			loadError: store.loadError ?? '',
		};
	};

	/**
	 * Create the selected entries of the pending plan.
	 *
	 * Shared by the page's confirm button and `/spec apply`, because two code
	 * paths that each create changes is two places for the confirmation guarantee
	 * to be got wrong.
	 *
	 * @param {string} sessionId - the session confirming.
	 * @returns {Promise<{ status: number, body: object }>} the response to send.
	 */
	const confirmProposal = async (sessionId) => {
		const draft = draftFor(sessionId);
		if (draft === undefined || draft.status !== DRAFT_STATUS.proposed || draft.proposal === undefined) {
			return { status: 409, body: errorBody('NO_PROPOSAL', '现在没有待确认的计划') };
		}
		const entries = draft.proposal.entries.filter((entry) => entry.include !== false);
		if (entries.length === 0) {
			return { status: 400, body: errorBody('NOTHING_SELECTED', '一个 change 都没勾选，没什么可创建的') };
		}
		try {
			const outcome = await proposals.apply({
				projectPath: draft.projectPath,
				entries,
				maxIterations: store.settings().ralphIterations,
				plannerSessionId: sessionId,
			});
			store.clearDraft(sessionId);
			return { status: 200, body: { ids: outcome.ids, warnings: outcome.warnings } };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!(error instanceof ProposalError)) log(`confirm failed for ${sessionId}: ${message}`);
			return { status: error instanceof ProposalError ? 400 : 500, body: errorBody('APPLY_FAILED', message) };
		}
	};

	/** Route one already-authorized request. */
	const route = async (req, res, pathname, body, query) => {
		const method = (req.method ?? 'GET').toUpperCase();

		// The path is resolved before the method, so an unknown route is a 404 and a
		// known route called the wrong way is a 405.
		if (READ_ROUTES.has(pathname)) {
			if (method !== 'GET') {
				sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', `${method} is not allowed on ${pathname}`));
				return;
			}
			const sessionId = query.get('sessionId');
			// The artifact bodies are fetched per entry rather than carried in the
			// snapshot: the page polls every few seconds, and shipping every proposed
			// spec on every tick to render a checklist would be waste.
			if (pathname === '/draft/entry') {
				const entry = entryFor(sessionId, query.get('id'));
				if (entry === undefined) {
					sendJson(res, 404, errorBody('ENTRY_NOT_FOUND', '这个待确认计划里没有这个条目'));
					return;
				}
				sendJson(res, 200, {
					id: entry.id,
					title: entry.title,
					summary: entry.summary,
					proposal: entry.proposal,
					design: entry.design,
					tasks: entry.tasks,
					specs: entry.specs,
				});
				return;
			}
			sendJson(res, 200, snapshot(projectFor(sessionId), sessionId));
			return;
		}
		if (!WRITE_ROUTES.has(pathname)) {
			sendJson(res, 404, errorBody('NOT_FOUND', `unknown route ${pathname}`));
			return;
		}
		if (method !== 'POST') {
			sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', `${method} is not allowed on ${pathname}`));
			return;
		}

		const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
		const projectPath = projectFor(sessionId);

		// Settings are the one mutating route that means something without a
		// project: they are global, and the page must be able to save them even
		// when the current session has no directory yet.
		if (pathname === '/settings') {
			const settings = store.updateSettings(body.settings ?? body);
			sendJson(res, 200, { settings, state: snapshot(projectPath, sessionId) });
			return;
		}

		// The draft routes are keyed by session, not by project: a discussion is a
		// conversation, and the plan it produced belongs to the session that had it.
		// This is also what lets them work before a project is known — `/spec` is
		// the thing that discovers the project in the first place.
		if (pathname.startsWith('/draft/')) {
			const draft = draftFor(sessionId);
			if (draft === undefined) {
				sendJson(res, 404, errorBody('NO_DISCUSSION', '这个会话没有讨论中的需求'));
				return;
			}
			switch (pathname) {
				case '/draft/update': {
					const edits = body.entries !== null && typeof body.entries === 'object' ? body.entries : {};
					store.mutate(() => {
						for (const entry of draft.proposal?.entries ?? []) {
							const edit = edits[entry.id];
							if (edit === null || typeof edit !== 'object') continue;
							if (typeof edit.include === 'boolean') entry.include = edit.include;
							// Only the title and summary are editable. The artifact bodies
							// come from the agent and the tasks are what the loop counts;
							// hand-editing either here would create a plan the agent never
							// reasoned about and a tally the loop cannot explain.
							if (typeof edit.title === 'string' && edit.title.trim().length > 0) entry.title = edit.title.trim();
							if (typeof edit.summary === 'string') entry.summary = edit.summary.trim();
						}
						draft.updatedAt = Date.now();
					});
					sendJson(res, 200, { state: snapshot(projectPath, sessionId) });
					return;
				}
				case '/draft/plan': {
					// The page's nudge button and `/spec plan` are the same message; the
					// nudge lives in `discourse.js` precisely so the two cannot drift.
					if (draft.status === DRAFT_STATUS.proposed) {
						sendJson(res, 409, errorBody('ALREADY_PROPOSED', '计划已经提交了，直接在页面上确认，或者 /spec cancel 后重新讨论'));
						return;
					}
					try {
						await sessions.submit({
							sessionId,
							text: renderPlanNudge({ requirement: draft.requirement }),
							requestId: `spec-loop-plan-${Date.now()}`,
						});
					} catch (error) {
						sendJson(res, 502, errorBody('NUDGE_FAILED', error instanceof Error ? error.message : String(error)));
						return;
					}
					sendJson(res, 202, { state: snapshot(projectPath, sessionId) });
					return;
				}
				case '/draft/apply': {
					const outcome = await confirmProposal(sessionId);
					sendJson(
						res,
						outcome.status,
						outcome.status === 200
							? { ...outcome.body, state: snapshot(projectPath, sessionId) }
							: outcome.body,
					);
					return;
				}
				case '/draft/discard': {
					store.clearDraft(sessionId);
					sendJson(res, 200, { discarded: true, state: snapshot(projectPath, sessionId) });
					return;
				}
				default:
					sendJson(res, 404, errorBody('NOT_FOUND', `unknown route ${pathname}`));
					return;
			}
		}

		if (projectPath === undefined) {
			sendJson(
				res,
				409,
				errorBody('NO_PROJECT', '这个会话还没有工作目录，插件无法确定要在哪个项目里操作 openspec。'),
			);
			return;
		}

		switch (pathname) {
			case '/init': {
				const openspec = new Openspec({ projectPath, command: commandFor(projectPath), log });
				try {
					await proposals.ensureInitialized(openspec);
				} catch (error) {
					sendJson(res, 500, errorBody('INIT_FAILED', error instanceof Error ? error.message : String(error)));
					return;
				}
				sendJson(res, 200, { state: snapshot(projectPath, sessionId) });
				return;
			}
			default:
				break;
		}

		// Every remaining route names a change, so the ownership check runs once.
		const record = typeof body.id === 'string' ? store.find(projectPath, body.id) : undefined;
		const needsChange = pathname !== '/changes/runAll' && pathname !== '/changes/refresh';
		if (needsChange && record === undefined) {
			sendJson(res, 404, errorBody('CHANGE_NOT_FOUND', `这个项目里没有 change "${String(body.id)}"`));
			return;
		}

		switch (pathname) {
			case '/changes/run': {
				const rounds = Number.isFinite(body.rounds) ? body.rounds : undefined;
				const outcome = runner.start(projectPath, body.id, rounds === undefined ? {} : { rounds });
				if (!outcome.queued) {
					sendJson(res, 409, errorBody('NOT_STARTABLE', outcome.reason ?? '这个 change 现在无法开始'));
					return;
				}
				sendJson(res, 200, { state: snapshot(projectPath, sessionId) });
				return;
			}
			case '/changes/runAll': {
				const rounds = Number.isFinite(body.rounds) ? body.rounds : undefined;
				const outcome = runner.startAll(projectPath, rounds === undefined ? {} : { rounds });
				sendJson(res, 200, { ...outcome, state: snapshot(projectPath, sessionId) });
				return;
			}
			case '/changes/stop': {
				const stopped = runner.stop(projectPath, body.id);
				sendJson(res, stopped ? 200 : 409, stopped
					? { state: snapshot(projectPath, sessionId) }
					: errorBody('NOT_ACTIVE', '这个 change 当前不在迭代中'));
				return;
			}
			case '/changes/update': {
				const maxIterations = Number.isFinite(body.maxIterations) ? Math.trunc(body.maxIterations) : undefined;
				const title = typeof body.title === 'string' ? body.title.trim() : undefined;
				const note = typeof body.note === 'string' ? body.note : undefined;
				store.mutate(() => {
					if (title !== undefined) record.title = title;
					if (note !== undefined) record.note = note;
					if (maxIterations !== undefined) {
						record.maxIterations = Math.min(50, Math.max(Math.max(1, record.iterations), maxIterations));
					}
					record.updatedAt = Date.now();
				});
				sendJson(res, 200, { state: snapshot(projectPath, sessionId) });
				return;
			}
			case '/changes/delete': {
				if (runner.isActive(projectPath, body.id)) {
					sendJson(res, 409, errorBody('STILL_ACTIVE', '先停止迭代，再删除'));
					return;
				}
				store.mutate((document) => {
					const bucket = document.projects[projectPath];
					if (bucket === undefined) return;
					bucket.changes = bucket.changes.filter((change) => change.id !== body.id);
				});
				sendJson(res, 200, {
					deleted: true,
					removedFromList: true,
					note: '只从列表移除，仓库里的 openspec/changes 目录没有被删除。',
					state: snapshot(projectPath, sessionId),
				});
				return;
			}
			case '/changes/refresh': {
				await proposals.refreshTasks(projectPath, typeof body.id === 'string' ? [body.id] : undefined);
				await reconcile(projectPath);
				sendJson(res, 200, { state: snapshot(projectPath, sessionId) });
				return;
			}
			default:
				sendJson(res, 404, errorBody('NOT_FOUND', `unknown route ${pathname}`));
		}
	};

	/**
	 * Add changes that exist on disk but are not in the list yet.
	 *
	 * The list is durable and the repository is not, so the two drift as soon as
	 * somebody creates a change by hand or pulls one from a branch. Importing them
	 * on refresh is what keeps the page from being a lie about the project.
	 *
	 * @param {string} projectPath - the project directory.
	 * @returns {Promise<void>} resolves once the store is up to date.
	 */
	const reconcile = async (projectPath) => {
		const openspec = new Openspec({ projectPath, command: commandFor(projectPath), log });
		const known = new Set(store.changes(projectPath).map((record) => record.id));
		let added = 0;
		for (const id of changeIdsOnDisk(projectPath)) {
			if (known.has(id)) continue;
			store.mutate(() => {
				store.ensure(projectPath, id, {
					maxIterations: store.settings().ralphIterations,
				});
			});
			added += 1;
		}
		if (added > 0) log(`从 ${openspec.projectPath} 导入 ${added} 个已存在的 change`);
	};

	/**
	 * The registered prefix handler.
	 * @param {object} req - the server request.
	 * @param {object} res - the server response.
	 */
	const handle = async function handle(req, res) {
		try {
			const raw = String(req.url ?? '/');
			const url = new URL(raw, 'http://localhost');
			const pathOnly = raw.split('?')[0];
			const pathname = (pathOnly.startsWith(ROUTE_PREFIX) ? pathOnly.slice(ROUTE_PREFIX.length) : pathOnly) || '/';
			const method = (req.method ?? 'GET').toUpperCase();

			if (MUTATIONS.has(method)) {
				if (!isLoopbackAddress(req.socket?.remoteAddress)) {
					sendJson(res, 403, errorBody('FORBIDDEN', 'state-changing requests are loopback-only'));
					return;
				}
				if (method !== 'DELETE' && !isJsonContentType(req.headers?.['content-type'])) {
					sendJson(res, 415, errorBody('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
					return;
				}
			}

			let body = {};
			if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
				try {
					body = await readJsonBody(req);
				} catch (error) {
					sendJson(res, 400, errorBody('BAD_REQUEST', error.message));
					return;
				}
			}

			await route(req, res, pathname, body, url.searchParams);
		} catch (error) {
			// A split that failed for a reason the user can act on keeps its message;
			// anything else is ours and is logged before it is reported.
			const message = error instanceof Error ? error.message : String(error);
			const expected = error instanceof ProposalError || error instanceof TypeError;
			if (!expected) log(`request failed: ${message}`);
			sendJson(res, expected ? 400 : 500, errorBody(expected ? 'BAD_REQUEST' : 'INTERNAL', message));
		}
	};

	// The startup pass needs the same reconciliation the refresh route uses, so it
	// is hung off the handler rather than duplicated in the wiring. A function with
	// a property is unusual, but the alternative — a second export the wiring has
	// to remember to call — is the kind of thing that silently goes missing.
	handle.reconcile = reconcile;
	return handle;
}
