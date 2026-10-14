/**
 * The ralph loop: run a fresh-agent ralph round over one OpenSpec change, again
 * and again, until the tasks are done or the round budget is spent.
 *
 * Each round is delegated to the shipped `ralph` tool rather than implemented
 * here. That tool owns the fresh-agent loop — every round a brand-new subagent
 * that receives only an immutable objective plus the previous bounded handoff,
 * with the shared workspace as durable memory — and it is the thing the user
 * means by "ralph". The plugin's job is the part ralph deliberately does not do:
 * deciding what the objective *is*, and deciding whether the round actually
 * advanced anything.
 *
 * So the split of responsibility is:
 *
 * - **Ralph** runs one round: a fresh agent, the objective, the workspace.
 * - **The plugin** re-derives the objective before every round from OpenSpec's
 *   own task list, and gates the next round on that list having moved.
 *
 * Which is why the objective is not a prose goal but the *remaining checkbox
 * list*: it makes the change's own `tasks.md` the handoff between rounds, so a
 * round cannot talk its way to "done" — only checking the box can. That is also
 * why `maxRounds` is 1 per invocation: the outer loop wants to observe between
 * rounds, and a round budget of one is the only setting where "iterations" on the
 * page means exactly what it says.
 *
 * Three endings deserve to be told apart, and the status vocabulary does:
 *
 * - `done` — the CLI reports zero remaining tasks.
 * - `exhausted` — the round budget ran out with work left. This is the normal
 *   case for a large change, and it is not an error: the user adds rounds.
 * - `blocked` — rounds are happening but the task tally has not moved. Something
 *   needs a human, and spending more rounds would only burn tokens.
 *
 * @module dsh-plugin-spec-loop/ralph
 */

import { Openspec } from './openspec.js';
import { CHANGE_STATUS, IDLE_STATUSES } from './state.js';
import { TurnTimeoutError } from './session.js';

/** How much of a round's reply is stored per log entry. */
const NOTE_EXCERPT = 1200;

/** The rounds one `ralph` invocation is asked for. */
export const ROUNDS_PER_INVOCATION = 1;

/**
 * The objective handed to the `ralph` tool.
 *
 * Written as an instruction to a *fresh* agent, because that is what receives
 * it: there is no conversation to lean on, so the objective has to name the
 * change, the directory, the exact remaining tasks, and the done-condition
 * without referring to anything earlier.
 *
 * @param {object} options - objective inputs.
 * @param {object} options.record - the change record.
 * @param {string} options.changeDir - the change directory.
 * @param {object} options.info - the CLI's apply report.
 * @returns {string} the objective text.
 */
export function renderObjective({ record, changeDir, info }) {
	const pending = (info.tasks ?? []).filter((task) => task.done !== true);
	// The description is reproduced exactly as `tasks.md` spells it, because that
	// is the line the round has to go and edit; prefixing the CLI's task id would
	// only make the list harder to match against the file.
	const pendingLines =
		pending.length > 0 ? pending.map((task) => `- [ ] ${task.description}`).join('\n') : '（读取时已经没有未完成任务）';
	const progress = info.progress ?? { total: 0, complete: 0, remaining: 0 };
	return [
		`实现 OpenSpec change「${record.id}」里尚未完成的任务。`,
		'',
		`- change id：\`${record.id}\``,
		`- change 标题：${record.title || '（未命名）'}`,
		`- change 目录：\`${changeDir}\``,
		`- 当前进度：已完成 ${progress.complete}/${progress.total} 条任务`,
		'',
		'本轮要完成的任务（来自该 change 的 `tasks.md`，这是权威清单）：',
		'',
		pendingLines,
		'',
		'# 要求',
		'',
		`1. 先读 \`${changeDir}/proposal.md\`、\`${changeDir}/design.md\`、\`${changeDir}/tasks.md\`，`,
		`   以及 \`${changeDir}/specs/\` 下的 spec 和任务涉及的代码。需要官方指令时可以跑`,
		`   \`openspec instructions apply --change ${record.id}\`。`,
		'2. 按依赖顺序把任务**真正做完**：改代码，并跑项目里已有的构建 / 测试 / lint 验证。',
		`3. 每确认完成一条任务，就把 \`${changeDir}/tasks.md\` 里对应的 \`- [ ]\` 改成 \`- [x]\`。`,
		'   只勾选**确实完成并且验证过**的任务；不要改任务文字，不要提前勾选。',
		`4. 不要修改 \`openspec/\` 下与 change \`${record.id}\` 无关的文件。`,
		'5. 遇到必须由人定夺的问题就停下来，在报告里用「阻塞：」开头写清楚缺什么决定，不要猜。',
		'',
		'# 关于这份 objective',
		'',
		'共享工作区是跨轮唯一的长期记忆，所以改动必须真正落到仓库里，不要只写在报告里。',
		'判断这一轮是否成功的唯一标准是：`tasks.md` 里有多少个 `- [ ]` 变成了 `- [x]`。',
	].join('\n');
}

/**
 * The prompt that makes a session call the `ralph` tool.
 *
 * The objective is fenced and labelled so the model can pass it through
 * verbatim. The fallback clause matters: `ralph` is a shipped tool that a
 * leaner profile may not compose, and a round that refuses to run at all would
 * turn "this profile has no ralph" into "this change is stuck" — two very
 * different problems that should not look alike on the page.
 *
 * @param {object} options - prompt inputs.
 * @param {object} options.record - the change record.
 * @param {string} options.objective - the objective text.
 * @param {number} options.round - the round number, 1-based.
 * @param {number} options.maxRounds - the round budget.
 * @returns {string} the prompt.
 */
export function renderRoundPrompt({ record, objective, round, maxRounds }) {
	return [
		`【Spec Loop · ralph 第 ${round}/${maxRounds} 轮 · change ${record.id}】`,
		'',
		'这一轮请**调用 `ralph` 工具**来执行，参数如下：',
		'',
		'objective:',
		'```text',
		objective,
		'```',
		'',
		`maxRounds: ${ROUNDS_PER_INVOCATION}`,
		'',
		'说明：',
		'',
		'- `ralph` 会为这一轮启动一个全新的子 agent，它只看得到上面这份 objective 和共享工作区。',
		'  所以请把 objective **逐字**传给 `ralph`，不要改写、不要补充。',
		'- 一轮只做一轮：`maxRounds` 传 1。轮与轮之间的推进由插件根据 `tasks.md` 自己判断。',
		'- 如果 `ralph` 工具不存在或调用失败，就**自己**按 objective 里的要求把这一轮做完：',
		'  读 change 目录、实现任务、把 `tasks.md` 里完成的条目改成 `- [x]`，然后汇报。',
		'',
		'本轮结束时用中文简短汇报：完成了哪几条、怎么验证的、还剩什么、有没有被阻塞。',
	].join('\n');
}

/** Truncate a note into something the page can show. */
function excerpt(text) {
	const value = typeof text === 'string' ? text.trim() : '';
	if (value.length <= NOTE_EXCERPT) return value;
	return `${value.slice(0, NOTE_EXCERPT)}…`;
}

/**
 * The loop engine, one runner per workspace's change list.
 */
export class RalphRunner {
	/** @type {Map<string, object>} `${projectPath}\u0000${id}` → the running round. */
	running = new Map();

	/** @type {object[]} changes waiting for a free slot. */
	pending = [];

	/**
	 * @param {object} options - construction options.
	 * @param {object} options.ctx - Host plugin context.
	 * @param {object} options.store - the durable store.
	 * @param {object} options.sessions - the session seam.
	 * @param {(projectPath: string) => string} options.commandFor - the configured CLI command.
	 * @param {() => boolean} [options.autoApprove] - whether rounds skip authorizations.
	 * @param {(message: string) => void} [options.log] - diagnostic sink.
	 */
	constructor({ ctx, store, sessions, commandFor, autoApprove, log = () => {} }) {
		this.ctx = ctx;
		this.store = store;
		this.sessions = sessions;
		this.commandFor = commandFor;
		this.autoApprove = autoApprove ?? (() => true);
		this.log = log;
	}

	/** The map key for one change. */
	static key(projectPath, id) {
		return `${projectPath}\u0000${id}`;
	}

	/**
	 * Whether a change is currently owned by the loop.
	 * @param {string} projectPath - the project directory.
	 * @param {string} id - the change id.
	 * @returns {boolean} true when it is running or queued.
	 */
	isActive(projectPath, id) {
		return this.running.has(RalphRunner.key(projectPath, id)) || this.pending.some((item) => item.projectPath === projectPath && item.id === id);
	}

	/**
	 * Queue one change, or raise its round budget first.
	 *
	 * @param {string} projectPath - the project directory.
	 * @param {string} id - the change id.
	 * @param {object} [options] - start options.
	 * @param {number} [options.rounds] - rounds to add on top of what it already ran.
	 * @returns {{ queued: boolean, reason?: string }} whether it was accepted.
	 */
	start(projectPath, id, options = {}) {
		const record = this.store.find(projectPath, id);
		if (record === undefined) return { queued: false, reason: `没有这个 change：${id}` };
		if (this.isActive(projectPath, id)) return { queued: false, reason: '这个 change 已经在跑了' };
		const rounds = Number.isFinite(options.rounds) ? Math.max(1, Math.trunc(options.rounds)) : undefined;
		this.store.mutate(() => {
			if (rounds !== undefined) record.maxIterations = Math.min(50, record.iterations + rounds);
			record.status = CHANGE_STATUS.queued;
			record.error = '';
			record.note = '';
			record.updatedAt = Date.now();
		});
		this.pending.push({ projectPath, id });
		this.#pump();
		return { queued: true };
	}

	/**
	 * Queue every change of a project that is not finished and not already active.
	 *
	 * @param {string} projectPath - the project directory.
	 * @param {object} [options] - start options.
	 * @param {number} [options.rounds] - rounds to add to each change.
	 * @returns {{ queued: string[], skipped: string[] }} what was accepted.
	 */
	startAll(projectPath, options = {}) {
		const queued = [];
		const skipped = [];
		for (const record of this.store.changes(projectPath)) {
			if (record.status === CHANGE_STATUS.done) {
				skipped.push(record.id);
				continue;
			}
			if (this.isActive(projectPath, record.id)) {
				skipped.push(record.id);
				continue;
			}
			const result = this.start(projectPath, record.id, options);
			if (result.queued) queued.push(record.id);
			else skipped.push(record.id);
		}
		return { queued, skipped };
	}

	/**
	 * Stop one change's loop.
	 * @param {string} projectPath - the project directory.
	 * @param {string} id - the change id.
	 * @returns {boolean} true when something was actually stopped.
	 */
	stop(projectPath, id) {
		const key = RalphRunner.key(projectPath, id);
		const before = this.pending.length;
		this.pending = this.pending.filter((item) => !(item.projectPath === projectPath && item.id === id));
		const removed = this.pending.length !== before;
		const active = this.running.get(key);
		if (active !== undefined) {
			active.controller.abort();
			return true;
		}
		if (removed) {
			this.store.mutate(() => {
				const record = this.store.find(projectPath, id);
				if (record === undefined) return;
				record.status = CHANGE_STATUS.cancelled;
				record.note = '已手动从队列中移除';
				record.updatedAt = Date.now();
			});
			return true;
		}
		return false;
	}

	/** Abort everything this runner owns. */
	dispose() {
		for (const active of this.running.values()) active.controller.abort();
		this.running.clear();
		this.pending = [];
	}

	/** Start queued work while a concurrency slot is free. */
	#pump() {
		const limit = this.store.settings().concurrency;
		while (this.running.size < limit && this.pending.length > 0) {
			const item = this.pending.shift();
			const key = RalphRunner.key(item.projectPath, item.id);
			if (this.running.has(key)) continue;
			const controller = new AbortController();
			this.running.set(key, { controller, projectPath: item.projectPath, id: item.id });
			void this.#run(item.projectPath, item.id, controller)
				.catch((error) => {
					this.log(`change ${item.id} 的迭代意外结束：${error instanceof Error ? error.message : String(error)}`);
				})
				.finally(() => {
					this.running.delete(key);
					this.#pump();
				});
		}
	}

	/**
	 * The loop for one change.
	 *
	 * @param {string} projectPath - the project directory.
	 * @param {string} id - the change id.
	 * @param {AbortController} controller - this run's cancellation.
	 * @returns {Promise<void>} resolves when the change leaves the loop.
	 */
	async #run(projectPath, id, controller) {
		const record = this.store.find(projectPath, id);
		if (record === undefined) return;
		const settings = this.store.settings();
		const openspec = new Openspec({ projectPath, command: this.commandFor(projectPath), log: this.log });
		if (!openspec.available) {
			this.#finish(projectPath, id, CHANGE_STATUS.failed, '找不到 openspec 命令，无法读取 change 进度。');
			return;
		}
		const changeDir = openspec.changeDir(id);
		const timeoutMs = settings.iterationTimeoutMinutes * 60 * 1000;

		this.store.mutate(() => {
			record.status = CHANGE_STATUS.running;
			record.startedAt = record.startedAt || Date.now();
			record.updatedAt = Date.now();
			record.error = '';
			record.note = '';
		});
		this.log(`开始迭代 change ${id}（已跑 ${record.iterations}/${record.maxIterations} 轮）`);

		let sessionId = '';
		let stall = 0;
		let lastDone = -1;
		let outcome = { status: CHANGE_STATUS.exhausted, error: '', note: '' };

		try {
			sessionId = await this.sessions.ensureSession({ sessionId: record.sessionId, projectPath });
			this.store.mutate(() => {
				record.sessionId = sessionId;
			});

			for (;;) {
				if (controller.signal.aborted) {
					outcome = { status: CHANGE_STATUS.cancelled, error: '', note: '已手动停止' };
					break;
				}

				// Read the CLI first, and check the work before the budget. Doing it the
				// other way round mislabels the common case: a change whose last task is
				// finished on its final round would reach the top of the loop with
				// `iterations === maxIterations` and be called `exhausted` even though
				// nothing is left. The budget is a limit on spending, not a verdict.
				const info = this.#readInfoSafe(await this.#applyInfo(openspec, id));
				if (info === undefined) {
					outcome = { status: CHANGE_STATUS.failed, error: 'openspec instructions apply 执行失败，无法读取任务列表。', note: '' };
					break;
				}
				const progress = info.progress ?? { total: 0, complete: 0, remaining: 0 };
				this.store.mutate(() => {
					record.tasksTotal = progress.total;
					record.tasksDone = progress.complete;
					record.updatedAt = Date.now();
				});

				if (progress.total === 0) {
					outcome = {
						status: CHANGE_STATUS.blocked,
						error: '',
						note: '这个 change 的 tasks.md 里没有任何 `- [ ]` 任务，没有可迭代的内容。请先补上任务清单。',
					};
					break;
				}
				if (progress.remaining === 0) {
					outcome = { status: CHANGE_STATUS.done, error: '', note: '所有任务都已完成。' };
					break;
				}
				if (record.iterations >= record.maxIterations) {
					outcome = {
						status: CHANGE_STATUS.exhausted,
						error: '',
						note: `已用完 ${record.maxIterations} 轮迭代，仍有 ${progress.remaining} 条任务未完成。再点「继续」可以追加轮数。`,
					};
					break;
				}

				// Progress is measured in completed tasks, which is the only thing the
				// loop is actually for. A round that leaves the number unchanged is a
				// round that did not advance the change.
				if (progress.complete === lastDone) stall += 1;
				else stall = 0;
				lastDone = progress.complete;
				if (stall >= settings.stallLimit) {
					outcome = {
						status: CHANGE_STATUS.blocked,
						error: '',
						note:
							`连续 ${settings.stallLimit} 轮没有任何任务被勾选完成，先停下来。` +
							'打开会话看看它卡在哪里：可能是任务本身需要人做决定，也可能是这一轮没有真正落到代码上。',
					};
					break;
				}

				const round = record.iterations + 1;
				this.store.mutate(() => {
					record.iterations = round;
					record.updatedAt = Date.now();
				});
				this.log(`change ${id} 第 ${round}/${record.maxIterations} 轮开始（${progress.complete}/${progress.total}）`);

				const startedAt = Date.now();
				let turn;
				try {
					turn = await this.sessions.runTurn({
						sessionId,
						text: renderRoundPrompt({
							record,
							objective: renderObjective({ record, changeDir, info }),
							round,
							maxRounds: record.maxIterations,
						}),
						requestId: `spec-loop-${id}-${round}-${startedAt}`,
						timeoutMs,
						autoApprove: this.autoApprove(),
						signal: controller.signal,
					});
				} catch (error) {
					const aborted = controller.signal.aborted;
					const isTimeout = error instanceof TurnTimeoutError;
					this.#appendLog(projectPath, id, {
						round,
						kind: 'ralph',
						status: aborted ? 'cancelled' : isTimeout ? 'timeout' : 'error',
						startedAt,
						finishedAt: Date.now(),
						tasksDone: progress.complete,
						tasksTotal: progress.total,
						note: error instanceof Error ? error.message : String(error),
					});
					outcome = aborted
						? { status: CHANGE_STATUS.cancelled, error: '', note: '已手动停止' }
						: {
								status: CHANGE_STATUS.failed,
								error: error instanceof Error ? error.message : String(error),
								note: '',
							};
					break;
				}

				// Re-read progress so the next round's prompt and the log entry both
				// reflect what this round actually changed.
				const after = this.#readInfoSafe(await this.#applyInfo(openspec, id));
				const afterProgress = after?.progress ?? progress;
				this.store.mutate(() => {
					record.tasksTotal = afterProgress.total;
					record.tasksDone = afterProgress.complete;
					record.updatedAt = Date.now();
				});
				this.#appendLog(projectPath, id, {
					round,
					kind: 'ralph',
					status: turn.error === undefined ? 'ok' : 'error',
					startedAt,
					finishedAt: Date.now(),
					tasksDone: afterProgress.complete,
					tasksTotal: afterProgress.total,
					note: turn.error !== undefined ? `会话报错：${turn.error}` : excerpt(turn.result),
				});
				this.log(
					`change ${id} 第 ${round} 轮结束：${progress.complete} → ${afterProgress.complete} / ${afterProgress.total}`,
				);
				if (turn.error !== undefined) {
					outcome = { status: CHANGE_STATUS.failed, error: turn.error, note: '' };
					break;
				}
			}
		} catch (error) {
			outcome =
				controller.signal.aborted
					? { status: CHANGE_STATUS.cancelled, error: '', note: '已手动停止' }
					: {
							status: CHANGE_STATUS.failed,
							error: error instanceof Error ? error.message : String(error),
							note: '',
						};
		}

		this.#finish(projectPath, id, outcome.status, outcome.error, outcome.note);
	}

	/** Read the CLI's apply report, returning undefined instead of throwing. */
	async #applyInfo(openspec, id) {
		try {
			return await openspec.applyInfo(id);
		} catch (error) {
			this.log(`读取 change ${id} 的 apply 指令失败：${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/** Guard a possibly-missing report. */
	#readInfoSafe(info) {
		if (info === undefined || info === null || typeof info !== 'object') return undefined;
		return info;
	}

	/**
	 * Append one round to a change's log.
	 * @param {string} projectPath - the project directory.
	 * @param {string} id - the change id.
	 * @param {object} entry - the log entry.
	 * @returns {void}
	 */
	#appendLog(projectPath, id, entry) {
		this.store.mutate(() => {
			const record = this.store.find(projectPath, id);
			if (record === undefined) return;
			record.log = [...(record.log ?? []), entry].slice(-50);
			record.updatedAt = Date.now();
		});
	}

	/**
	 * Close out a run.
	 * @param {string} projectPath - the project directory.
	 * @param {string} id - the change id.
	 * @param {string} status - the terminal status.
	 * @param {string} [error] - the failure text.
	 * @param {string} [note] - the explanation shown to the user.
	 * @returns {void}
	 */
	#finish(projectPath, id, status, error, note) {
		this.store.mutate(() => {
			const record = this.store.find(projectPath, id);
			if (record === undefined) return;
			const now = Date.now();
			// A run that was cancelled before it started leaves no trace but the
			// status, so the record keeps whatever it had.
			record.status = status;
			record.finishedAt = now;
			record.updatedAt = now;
			record.error = error ?? '';
			record.note = note ?? '';
		});
		this.log(`change ${id} 迭代结束：${status}${error !== undefined && error.length > 0 ? ` — ${error}` : ''}`);
	}

	/**
	 * Whether a change can be started right now.
	 * @param {object} record - the change record.
	 * @returns {boolean} true when it is idle.
	 */
	static isStartable(record) {
		return IDLE_STATUSES.has(record.status);
	}
}
