/**
 * The session seam: create a session in the right project, send it one prompt,
 * and know when the round is really over.
 *
 * Three things are handled here rather than left implicit, because each one has
 * a wrong version that looks right:
 *
 * - **Admission is not completion.** `prompt` resolves as soon as the Agent
 *   accepts the message; the turn runs afterwards. So a round is observed rather
 *   than awaited: this file watches `agent/status` for `running → idle`, and
 *   only accepts an `idle` it saw preceded by a `running`. Without that guard the
 *   first idle — observed in the moment between admission and the turn starting —
 *   would end every round instantly and the loop would spin through its budget
 *   without doing any work.
 * - **A session must land in the project.** The ralph session is created with an
 *   explicit `cwd`, so an OpenSpec command it runs resolves to the same
 *   repository the page is showing. One created without it would inherit the
 *   Host's process directory and quietly work on the wrong tree.
 * - **A round must not hang.** A turn that never settles would hold a
 *   concurrency slot until the Host restarts, so every round carries a deadline
 *   and the turn is cancelled when it passes.
 *
 * @module dsh-plugin-spec-loop/session
 */

/** How much of an assistant reply is kept for the page. */
const RESULT_EXCERPT = 4000;

/** A round that ran out of time. */
export class TurnTimeoutError extends Error {
	/** @param {string} message - the explanation. */
	constructor(message) {
		super(message);
		this.name = 'TurnTimeoutError';
	}
}

/** Turn an arbitrary thrown value into something printable. */
export function errorText(error) {
	if (error === undefined || error === null) return 'unknown error';
	if (typeof error === 'string') return error;
	if (error instanceof Error) return error.message;
	if (typeof error.message === 'string') return error.message;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/**
 * The newest assistant text in a session.
 *
 * Read from the session log rather than from the live stream, so it also works
 * for a round that finished while the page was closed.
 *
 * @param {object} session - a live session.
 * @returns {string | undefined} the excerpt, or undefined when there is none.
 */
export function lastAssistantText(session) {
	try {
		const events = session.snapshotEvents();
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type !== 'assistant/message') continue;
			const blocks = event.data?.message?.content ?? [];
			const text = blocks
				.filter((block) => block?.type === 'text' && typeof block.text === 'string')
				.map((block) => block.text)
				.join('\n')
				.trim();
			if (text.length === 0) continue;
			return text.length > RESULT_EXCERPT ? `${text.slice(0, RESULT_EXCERPT)}…` : text;
		}
	} catch {
		/* A session that will not read back simply has no excerpt. */
	}
	return undefined;
}

/**
 * Creates and drives sessions on behalf of the loop.
 */
export class SessionSeam {
	/** @type {Map<string, object>} session id → the waiter watching it. */
	waiters = new Map();

	/**
	 * @param {object} options - construction options.
	 * @param {object} options.ctx - Host plugin context.
	 * @param {object} options.privileges - the unattended-execution helper.
	 * @param {(message: string) => void} [options.log] - diagnostic sink.
	 */
	constructor({ ctx, privileges, log = () => {} }) {
		this.ctx = ctx;
		this.privileges = privileges;
		this.log = log;
	}

	/**
	 * Observe agent status and errors.
	 * @returns {() => void} a disposer that removes the listeners.
	 */
	install() {
		const disposers = [
			this.ctx.on('agent/status', (payload) => this.#onStatus(payload)),
			this.ctx.on('agent/error', (payload) => this.#onError(payload)),
		];
		return () => {
			for (const dispose of disposers) dispose();
			this.dispose();
		};
	}

	/** Fail every waiter, so a plugin unload does not leave a promise hanging. */
	dispose() {
		for (const waiter of this.waiters.values()) {
			if (waiter.timer !== undefined) clearTimeout(waiter.timer);
			waiter.reject(new Error('spec-loop 已卸载，回合被中断'));
		}
		this.waiters.clear();
	}

	/**
	 * Whether a session currently has a turn in flight.
	 * @param {string} sessionId - the session to test.
	 * @returns {boolean} true when the agent is running.
	 */
	isBusy(sessionId) {
		try {
			return this.ctx.agents.get(sessionId)?.status === 'running';
		} catch {
			return false;
		}
	}

	/**
	 * Create (or adopt) a session bound to one project directory.
	 *
	 * A session that already exists is returned as-is rather than re-created:
	 * adopting one through `create({ sessionId })` looks idempotent and is not,
	 * because the controller refuses to adopt a session whose recorded directory
	 * differs from the requested one. Resuming is what keeps an existing ralph
	 * session's conversation.
	 *
	 * @param {object} options - creation options.
	 * @param {string} [options.sessionId] - an existing session to reuse.
	 * @param {string} options.projectPath - the project directory to work in.
	 * @param {string} [options.agentPreset] - the preset to create with.
	 * @returns {Promise<string>} the session id.
	 */
	async ensureSession({ sessionId, projectPath, agentPreset }) {
		if (typeof sessionId === 'string' && sessionId.length > 0) {
			const resolved = await this.#resolveAgent(sessionId);
			if (resolved !== undefined) return sessionId;
			// The recorded session is gone — deleted with its workspace, or from a
			// profile that no longer has it. Falling through to a fresh one is better
			// than failing the change forever.
			this.log(`session ${sessionId} 已不存在，重新创建一个`);
		}
		const request = { cwd: projectPath };
		if (typeof agentPreset === 'string' && agentPreset.length > 0) request.agentPreset = agentPreset;
		const created = await this.ctx.sessionController.create(request);
		return created.sessionId;
	}

	/**
	 * Resolve the live agent of a session, or undefined when it is gone.
	 * @param {string} sessionId - the session to resolve.
	 * @returns {Promise<object | undefined>} the live agent.
	 */
	async #resolveAgent(sessionId) {
		const resolved = await this.ctx.sessionController.resolveAgent(sessionId);
		if (resolved !== undefined && resolved !== null && 'error' in resolved) return undefined;
		const agent = resolved?.agent ?? this.ctx.agents.get(sessionId);
		if (agent === undefined || agent === null || agent.session === undefined) return undefined;
		return agent;
	}

	/**
	 * Whether a tool is actually visible to a session's agent right now.
	 *
	 * Asked of the registry rather than assumed from the profile, because
	 * "which tools exist" is composed per agent preset and can be narrowed
	 * again by a scope's restrictions: a tool can be registered globally and
	 * still read as absent for the agent that will run the round. Passing the
	 * agent as the viewing scope is the documented way to get that answer, and
	 * the only way to know what the model will actually be able to call.
	 *
	 * @param {string} name - the tool name as registered.
	 * @param {string} sessionId - the session whose agent's view is wanted.
	 * @returns {Promise<boolean>} true when that agent could call the tool.
	 */
	async hasTool(name, sessionId) {
		const agent = await this.#resolveAgent(sessionId);
		if (agent === undefined) return false;
		try {
			const tools = this.ctx.get?.('tools') ?? this.ctx.tools;
			if (tools === undefined || typeof tools.get !== 'function') return false;
			return tools.get(name, agent) !== undefined;
		} catch (error) {
			// Answering "no" is the safe direction: a round that does its own work is
			// correct whatever the toolset was, while a round told to call a tool that
			// may not exist spends a step finding out. Neither may fail the change, so
			// nothing in here is allowed to escape.
			this.log(`无法确认工具 ${name} 是否可用：${String(error)}`);
			return false;
		}
	}

	/**
	 * Send one prompt and resolve once its turn has ended.
	 *
	 * @param {object} options - the round.
	 * @param {string} options.sessionId - the session to prompt.
	 * @param {string} options.text - the prompt text.
	 * @param {string} options.requestId - a stable id for this round.
	 * @param {number} options.timeoutMs - how long the turn may run.
	 * @param {boolean} options.autoApprove - whether to relax the session first.
	 * @param {AbortSignal} [options.signal] - caller cancellation.
	 * @returns {Promise<{ result: string, error: string | undefined, session: object }>} the round outcome.
	 */
	async runTurn({ sessionId, text, requestId, timeoutMs, autoApprove, signal }) {
		const agent = await this.#resolveAgent(sessionId);
		if (agent === undefined) throw new Error(`会话 ${sessionId} 无法激活`);

		this.privileges.harden(agent, autoApprove);

		// A round must start from an idle agent: prompting a busy one would append
		// to the turn already running, and the waiter would then be watching a
		// boundary that belongs to somebody else's prompt.
		await this.#waitIdle(sessionId, timeoutMs, signal);

		const waiter = this.#arm(sessionId, timeoutMs, signal);
		try {
			await this.ctx.sessionController.prompt(
				{
					sessionId,
					mode: 'queue',
					requestId,
					content: [{ type: 'text', text }],
				},
				signal ?? new AbortController().signal,
			);
		} catch (error) {
			this.#disarm(sessionId);
			throw error;
		}
		const outcome = await waiter;
		const session = agent.session;
		return { result: lastAssistantText(session) ?? '', error: outcome.error, session };
	}

	/**
	 * Send one prompt and resolve as soon as the Agent has accepted it.
	 *
	 * The counterpart to `runTurn`, for a message a *human* is about to carry on
	 * from: the discussion a `/spec` command opens. Waiting for the turn would
	 * hold the command open for as long as the agent talks, and the command's own
	 * result renders the moment it returns — so admission is the whole promise
	 * here, and nothing is claimed about the turn that follows.
	 *
	 * The session is deliberately not hardened. `runTurn` relaxes the sessions the
	 * plugin drives on its own, but this is the user's own conversation with the
	 * agent: taking the approval prompts away here would silently change how their
	 * session behaves from the moment they run a command.
	 *
	 * @param {object} options - the message.
	 * @param {string} options.sessionId - the session to prompt.
	 * @param {string} options.text - the prompt text.
	 * @param {string} options.requestId - a stable id for this message.
	 * @returns {Promise<void>} resolves once the message is admitted.
	 */
	async submit({ sessionId, text, requestId }) {
		const agent = await this.#resolveAgent(sessionId);
		if (agent === undefined) throw new Error(`会话 ${sessionId} 无法激活`);
		await this.ctx.sessionController.prompt(
			{
				sessionId,
				mode: 'queue',
				requestId,
				content: [{ type: 'text', text }],
			},
			new AbortController().signal,
		);
	}

	/**
	 * Cancel whatever turn a session is running.
	 * @param {string} sessionId - the session to cancel.
	 * @returns {void}
	 */
	cancel(sessionId) {
		try {
			this.ctx.sessionController.cancel({ sessionId });
		} catch (error) {
			this.log(`could not cancel ${sessionId}: ${errorText(error)}`);
		}
	}

	/**
	 * Arm a waiter for a session's round.
	 * @param {string} sessionId - the session to watch.
	 * @param {number} timeoutMs - the deadline.
	 * @param {AbortSignal} [signal] - caller cancellation.
	 * @returns {Promise<{ error: string | undefined }>} resolves when the turn ends.
	 */
	#arm(sessionId, timeoutMs, signal) {
		this.#disarm(sessionId);
		return new Promise((resolvePromise, rejectPromise) => {
			const waiter = {
				phase: 'turn',
				sawRunning: false,
				error: undefined,
				resolve: resolvePromise,
				reject: rejectPromise,
				timer: undefined,
				signal,
				onAbort: undefined,
				sessionId,
			};
			if (signal?.aborted === true) {
				rejectPromise(new Error('已手动停止'));
				return;
			}
			if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
				const timer = setTimeout(() => {
					this.log(`会话 ${sessionId} 的一轮超过 ${Math.round(timeoutMs / 60000)} 分钟，取消该轮`);
					this.cancel(sessionId);
					this.#settle(
						sessionId,
						new TurnTimeoutError(`本轮超过 ${Math.round(timeoutMs / 60000)} 分钟未结束，已取消`),
					);
				}, timeoutMs);
				if (typeof timer.unref === 'function') timer.unref();
				waiter.timer = timer;
			}
			if (signal !== undefined) {
				const onAbort = () => {
					this.cancel(sessionId);
					this.#settle(sessionId, new Error('已手动停止'));
				};
				signal.addEventListener('abort', onAbort, { once: true });
				waiter.onAbort = onAbort;
			}
			this.waiters.set(sessionId, waiter);
		});
	}

	/**
	 * Wait until a session's agent is idle.
	 * @param {string} sessionId - the session to watch.
	 * @param {number} timeoutMs - the deadline.
	 * @param {AbortSignal} [signal] - caller cancellation.
	 * @returns {Promise<void>} resolves once idle.
	 */
	#waitIdle(sessionId, timeoutMs, signal) {
		const agent = (() => {
			try {
				return this.ctx.agents.get(sessionId);
			} catch {
				return undefined;
			}
		})();
		if (agent === undefined || agent.status !== 'running') return Promise.resolve();
		return new Promise((resolvePromise, rejectPromise) => {
			const waiter = {
				phase: 'idle',
				sawRunning: true,
				error: undefined,
				resolve: () => resolvePromise(),
				reject: rejectPromise,
				timer: undefined,
				signal,
				onAbort: undefined,
				sessionId,
			};
			if (signal?.aborted === true) {
				rejectPromise(new Error('已手动停止'));
				return;
			}
			if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
				const timer = setTimeout(() => {
					this.#settle(sessionId, new TurnTimeoutError('等待上一个回合结束时超时'));
				}, timeoutMs);
				if (typeof timer.unref === 'function') timer.unref();
				waiter.timer = timer;
			}
			if (signal !== undefined) {
				const onAbort = () => this.#settle(sessionId, new Error('已手动停止'));
				signal.addEventListener('abort', onAbort, { once: true });
				waiter.onAbort = onAbort;
			}
			this.waiters.set(sessionId, waiter);
		});
	}

	/**
	 * Settle and clear a session's waiter.
	 * @param {string} sessionId - the session.
	 * @param {Error} [error] - the failure, if any.
	 * @param {string} [agentError] - an error the turn reported.
	 * @returns {void}
	 */
	#settle(sessionId, error, agentError) {
		const waiter = this.waiters.get(sessionId);
		if (waiter === undefined) return;
		this.#disarm(sessionId);
		waiter.error = agentError ?? waiter.error;
		if (error !== undefined) waiter.reject(error);
		else waiter.resolve({ error: waiter.error });
	}

	/** Drop a session's waiter and its timer. */
	#disarm(sessionId) {
		const waiter = this.waiters.get(sessionId);
		if (waiter === undefined) return;
		if (waiter.timer !== undefined) clearTimeout(waiter.timer);
		if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
			try {
				waiter.signal.removeEventListener('abort', waiter.onAbort);
			} catch {
				/* Nothing to detach. */
			}
		}
		this.waiters.delete(sessionId);
	}

	/**
	 * Observe one status change.
	 * @param {{ agent: object, status: string }} payload - the event payload.
	 */
	#onStatus({ agent, status }) {
		const sessionId = agent?.session?.id;
		const waiter = this.waiters.get(sessionId);
		if (waiter === undefined) return;
		if (status === 'running') {
			waiter.sawRunning = true;
			return;
		}
		if (status !== 'idle') return;
		if (waiter.phase === 'idle') {
			this.#settle(sessionId);
			return;
		}
		// The first idle after admission does not count: it is the gap before the
		// turn actually starts. Only an idle preceded by a running ends the round.
		if (!waiter.sawRunning) return;
		this.#settle(sessionId);
	}

	/**
	 * Remember that a managed session errored; the failure is reported when the
	 * turn closes, so the page never shows a round failed while it is progressing.
	 * @param {{ agent: object, error: unknown }} payload - the event payload.
	 */
	#onError({ agent, error }) {
		const waiter = this.waiters.get(agent?.session?.id);
		if (waiter === undefined) return;
		waiter.error = errorText(error);
	}
}
