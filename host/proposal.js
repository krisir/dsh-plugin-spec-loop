/**
 * Requirement → changes: the proposal half of the plugin.
 *
 * The split is done by an agent, not by a parser: deciding where one change ends
 * and the next begins needs the repository — its conventions, its existing
 * specs, its config rules — and that is exactly what an agent with file tools
 * can read and a regex cannot.
 *
 * What this module keeps control of is *when* anything is created, and *that the
 * result is real*. The agent discusses and then hands over a plan through the
 * `spec_loop_propose` tool — ids, titles, and why each is its own change, and
 * nothing else. The documents are deliberately not the plugin's to write.
 * Creating an OpenSpec change means running `openspec new change`, honouring the
 * project's configured schema, and laying out proposal / specs / design / tasks
 * the way that schema and its validator expect — and the `openspec-propose` skill
 * already knows how to do exactly that. Re-implementing it here would mean a
 * second implementation that drifts from the installed CLI the first time OpenSpec
 * changes a template.
 *
 * So on the user's confirm this module hands the job back: it sends the agent a
 * prompt naming the exact ids and telling it to run that skill, waits for the
 * turn to end, and then checks every requested id against what is actually on
 * disk. A plan that produced no change directory is reported as a failure, not
 * papered over with files the plugin wrote itself.
 *
 * Nothing here creates anything until the user confirms. The agent proposes, the
 * user confirms, the agent creates, and this module verifies and registers.
 *
 * @module dsh-plugin-spec-loop/proposal
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Openspec, OpenspecError, changeIdsOnDisk, readTasks } from './openspec.js';

/**
 * The skill the agent runs to create the changes.
 *
 * Named here rather than left to the prompt's prose because the plugin both
 * checks for it up front and reports its absence by name.
 */
export const CREATE_SKILL = 'openspec-propose';

/**
 * The first line of the creation prompt.
 *
 * Exported because a test that re-types this string is a test that stops testing
 * the real prompt the moment someone edits the wording.
 */
export const CREATION_MARKER = '【Spec Loop · 创建已确认的 change】';

/** A proposal that could not be turned into changes. */
export class ProposalError extends Error {
	/**
	 * @param {string} message - the explanation.
	 * @param {object} [detail] - captured context.
	 */
	constructor(message, detail = {}) {
		super(message);
		this.name = 'ProposalError';
		this.detail = detail;
	}
}

/** Kebab-case a candidate id, or return '' when nothing usable is left. */
export function toKebab(value) {
	return String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
}

/**
 * Validate and normalize a raw plan into the entries the creator can use.
 *
 * Everything the model controls is treated as hostile input here: the id is
 * kebab-cased and de-duplicated, and an entry with no usable id or title is
 * dropped rather than handed to the agent as a change nobody can name.
 *
 * @param {object} plan - the tool arguments the agent sent.
 * @param {string[]} taken - ids already in use, which new ids must avoid.
 * @returns {{ entries: object[], dropped: object[] }} the accepted entries and the rejected ones.
 */
export function normalizeProposal(plan, taken) {
	const rawList = Array.isArray(plan?.changes) ? plan.changes : [];
	const used = new Set(taken);
	const entries = [];
	const dropped = [];
	for (const raw of rawList) {
		if (raw === null || typeof raw !== 'object') {
			dropped.push({ reason: '条目不是对象' });
			continue;
		}
		const base = toKebab(raw.id ?? raw.title);
		if (base.length === 0) {
			dropped.push({ reason: '无法从 id/title 推导出合法的 change id', raw: raw.title ?? raw.id });
			continue;
		}
		let id = base;
		let suffix = 2;
		while (used.has(id)) {
			id = `${base}-${suffix}`;
			suffix += 1;
		}
		const title = typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title.trim() : '';
		if (title.length === 0) {
			// The title is what the change list and the plan review both show; an
			// untitled entry would appear as a bare id in both.
			dropped.push({ id, reason: '没有标题' });
			continue;
		}
		used.add(id);
		entries.push({
			id,
			title,
			summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
		});
	}
	return { entries, dropped };
}

/**
 * The plan contract the agent must follow, shared by every prompt that asks for a
 * plan so the rules cannot drift between the opener and the nudge.
 *
 * The rules are about the *split*, not about file formats. What the artifacts
 * must contain is the skill's business, and it reads it from the project's own
 * schema — so repeating templates here would only create a second copy to keep in
 * sync with the installed CLI.
 *
 * @returns {string} the rules as prompt text.
 */
export function renderProposalRules() {
	return [
		'# 计划要满足的格式',
		'',
		'用 `spec_loop_propose` 工具提交计划。每个 change 只有三个字段：',
		'',
		'```json',
		'{',
		'  "id": "kebab-case-id（小写英文，连字符）",',
		'  "title": "一句话中文标题",',
		'  "summary": "两三句话：做什么、为什么它该独立成一个 change（有先后依赖就写「依赖：<id>」）",',
		'}',
		'```',
		'',
		'**只提交计划，不要写任何文档正文，也不要自己创建 `openspec/changes/` 目录。**',
		'proposal.md / specs / design.md / tasks.md 都不由你在这里产出：用户确认之后，插件会让你',
		`自己调用 \`${CREATE_SKILL}\` 技能（用 \`skill\` 工具加载）去创建这些 change，`,
		'届时由那个技能按项目自己的 schema 生成四份文档。',
		'',
		'# 拆分的硬性规则',
		'',
		'- **尽量拆细。**一个 change 只做一件事，能在一次迭代里独立实现、独立验证。宁可多拆几个',
		'  小的，也不要交一个大而全的 —— 后面每个 change 会被单独跑多轮迭代，拆得细才跑得动。',
		'- 但也要**拆得有意义**：不能独立验证的碎片不要单独成 change，它们应该合进相邻的那个。',
		'- 每个 change 必须有自己能观察到的完成状态，否则无法判断迭代有没有进展。',
		'- `id` 一旦提交就是最终的目录名，创建时会要求技能严格照用，所以取一个能长期存在的名字。',
		'- 有先后依赖的，写在 `summary` 里（「依赖：<id>」），列表会按你提交的顺序展示。',
		'',
		'所有标题和摘要用中文（代码标识符、路径、命令保持原文）。',
	].join('\n');
}

/**
 * The prompt that sends the agent off to create the confirmed changes.
 *
 * The ids are repeated as an explicit checklist rather than left implicit in the
 * plan, because the plugin verifies by id afterwards: an agent that renames
 * `add-dark-mode` to `dark-mode-support` while creating it produces a change the
 * user never approved under a name the list cannot match to the plan.
 *
 * @param {object} options - prompt inputs.
 * @param {object[]} options.entries - the confirmed plan entries.
 * @param {string} options.projectPath - the repository to create them in.
 * @returns {string} the prompt.
 */
export function renderCreationPrompt({ entries, projectPath }) {
	const lines = [
		CREATION_MARKER,
		'',
		`用户已经确认了下面 ${entries.length} 个 change。现在请你**创建它们**。`,
		'',
		`请用 \`skill\` 工具加载 \`${CREATE_SKILL}\` 技能，然后按它的流程逐个创建：`,
		'',
		...entries.map((entry, index) => {
			const summary = entry.summary.length > 0 ? `\n    ${entry.summary.replace(/\n+/g, ' ')}` : '';
			return `${index + 1}. \`${entry.id}\` —— ${entry.title}${summary}`;
		}),
		'',
		'要求：',
		'',
		`- **目录名必须严格等于上面列的 id**，一个字符都不要改、不要加后缀、不要另起名字。`,
		'  插件会用这些 id 逐个核对，对不上就等于这个 change 没建成。',
		'- 每个 change 的 `tasks.md` 必须是**真正的 `- [ ]` 复选框列表** —— 后续迭代循环只按',
		'  这个勾选数统计进展，没有复选框的 change 跑不起来。',
		'- 只做规划产物，**不要动项目代码**（那个技能本身也是这个边界）。',
		`- 工作目录是 \`${projectPath}\`。`,
		'',
		'全部创建完之后，用中文简短汇报：建了哪几个、每个的 id 是什么、有没有遇到问题。',
	];
	return lines.join('\n');
}

/**
 * The proposal operations: a validated plan in, created change records out.
 */
export class Proposals {
	/**
	 * @param {object} options - construction options.
	 * @param {object} options.store - the durable store.
	 * @param {object} options.sessions - the session seam, for driving the creating turn.
	 * @param {(projectPath: string) => string} options.commandFor - the configured CLI command.
	 * @param {() => boolean} [options.autoApprove] - whether the creating turn skips authorizations.
	 * @param {number | (() => number)} [options.timeoutMs] - how long the creating turn may
	 *   run. Defaults to the same budget a loop round gets, because creating a change and
	 *   finishing a round are comparable work and a second, hidden ceiling would only
	 *   surprise the user who raised the visible one.
	 * @param {(message: string) => void} [options.log] - diagnostic sink.
	 */
	constructor({ store, sessions, commandFor, autoApprove, timeoutMs, log = () => {} }) {
		this.store = store;
		this.sessions = sessions;
		this.commandFor = commandFor;
		this.autoApprove = autoApprove ?? (() => true);
		this.timeoutSetting = timeoutMs ?? (() => 20 * 60 * 1000);
		this.log = log;
	}

	/** How long the creating turn may run, resolved per call. */
	get timeoutMs() {
		const value = typeof this.timeoutSetting === 'function' ? this.timeoutSetting() : this.timeoutSetting;
		return Number.isFinite(value) && value > 0 ? value : 20 * 60 * 1000;
	}

	/**
	 * Ensure the project has an OpenSpec root, initializing it when it does not.
	 *
	 * Initializing a repository is not creating a change, so this stays: the skill
	 * needs a root to write into, and refusing to make one would turn "this project
	 * has not adopted OpenSpec yet" into an error the user has to resolve by hand
	 * before the confirm button can work at all.
	 *
	 * @param {Openspec} openspec - the bound CLI.
	 * @returns {Promise<string>} the project root.
	 */
	async ensureInitialized(openspec) {
		const existing = openspec.root;
		if (existing !== undefined) return existing;
		if (!openspec.available) {
			throw new ProposalError(
				`找不到 \`${openspec.command}\` 命令，无法初始化 OpenSpec。请在项目里装好 OpenSpec CLI，或者用 \`/spec env\` 看诊断。`,
			);
		}
		this.log(`openspec init in ${openspec.projectPath}`);
		await openspec.init();
		const root = openspec.root;
		if (root === undefined) {
			throw new ProposalError(`openspec init 执行完了，但 ${openspec.projectPath} 下仍然没有 openspec/config.yaml`);
		}
		return root;
	}

	/**
	 * Create the confirmed entries as real OpenSpec changes, by asking the agent.
	 *
	 * This is the only place in the plugin that creates changes, and it is reached
	 * from the user's confirm action alone. It does not write the change files: it
	 * drives a turn in which the agent runs the OpenSpec skill, and then holds the
	 * result to account against `/spec`'s promise — every id the user approved
	 * exists on disk, and nothing shows up under a name they did not approve.
	 *
	 * @param {object} options - the request.
	 * @param {string} options.projectPath - the repository to create them in.
	 * @param {object[]} options.entries - the confirmed, normalized plan entries.
	 * @param {number} options.maxIterations - rounds each new change gets.
	 * @param {string} options.plannerSessionId - the session that will create them.
	 * @returns {Promise<{ ids: string[], warnings: string[] }>} the outcome.
	 */
	async apply({ projectPath, entries, maxIterations, plannerSessionId = '' }) {
		if (entries.length === 0) throw new ProposalError('没有选中任何 change');
		if (plannerSessionId.length === 0) {
			throw new ProposalError('不知道这次确认来自哪个会话，没法让它去创建 change。');
		}

		const openspec = new Openspec({ projectPath, command: this.commandFor(projectPath), log: this.log });
		await this.ensureInitialized(openspec);

		// Asking for the skill before spending a turn on it turns "this profile has
		// no openspec-propose" into one specific sentence, instead of a turn that
		// discovers the same thing and then has to explain itself.
		if (typeof this.sessions.skillMissing === 'function') {
			const missing = await this.sessions.skillMissing(CREATE_SKILL, plannerSessionId, projectPath);
			if (missing) {
				throw new ProposalError(
					`这个会话里没有 \`${CREATE_SKILL}\` 技能，没法用它创建 change。` +
						'请确认技能已经装好（agent 通过 `skill` 工具加载它），或者换一个装了它的 profile。',
					{ skill: CREATE_SKILL },
				);
			}
		}

		const requested = entries.map((entry) => toKebab(entry.id));
		const before = new Set(changeIdsOnDisk(projectPath));

		try {
			await this.sessions.runTurn({
				sessionId: plannerSessionId,
				text: renderCreationPrompt({ entries, projectPath }),
				requestId: `spec-loop-apply-${Date.now()}`,
				timeoutMs: this.timeoutMs,
				autoApprove: this.autoApprove(),
			});
		} catch (error) {
			throw new ProposalError(
				`创建 change 的那一轮没有跑完：${error instanceof Error ? error.message : String(error)}`,
				{ requested },
			);
		}

		const after = changeIdsOnDisk(projectPath);
		const present = new Set(after);
		const ids = requested.filter((id) => present.has(id));
		const missing = requested.filter((id) => !present.has(id));
		// A change the agent created under a name nobody approved. It is on disk, so
		// it exists whether or not the plugin records it — staying quiet about it
		// would leave the user with a stray change and no idea where it came from.
		const unexpected = after.filter((id) => !before.has(id) && !requested.includes(id));

		if (ids.length === 0) {
			// "Nothing was created" would be a lie when the agent created something
			// under a name it invented — and that stray change is on disk, so the user
			// needs to be told about it rather than left to find it.
			const stray =
				unexpected.length > 0
					? `仓库里倒是多出了 ${unexpected.join('、')}，但名字和你确认的对不上，所以没有登记。`
					: '';
			throw new ProposalError(
				`确认了 ${entries.length} 个 change，但一个都没按你确认的 id 建出来。` +
					`请求的 id：${requested.join('、')}。${stray}打开会话看看那一轮卡在哪里。`,
				{ requested, missing, unexpected, after },
			);
		}

		const warnings = [];
		if (missing.length > 0) {
			warnings.push(`这些 id 没有出现在仓库里：${missing.join('、')}（可能是技能改了名字，或者没建完）`);
		}
		if (unexpected.length > 0) {
			warnings.push(`仓库里多出了计划外的 change：${unexpected.join('、')}（已建出来，但没有登记进列表）`);
		}

		for (const id of ids) {
			const entry = entries.find((candidate) => toKebab(candidate.id) === id);
			const warning = await this.#register({ openspec, projectPath, id, entry, maxIterations, plannerSessionId });
			if (warning.length > 0) warnings.push(`${id}：${warning}`);
		}

		this.log(`created ${ids.length} change(s) in ${projectPath}: ${ids.join(', ')}`);
		return { ids, warnings };
	}

	/**
	 * Record one created change, reading its real state back off the disk.
	 *
	 * Everything here is read from the files the skill wrote, never from the plan:
	 * the plan said what the user wanted, the files say what they got, and only the
	 * second one can be iterated.
	 *
	 * @param {object} options - the change.
	 * @param {Openspec} options.openspec - the bound CLI.
	 * @param {string} options.projectPath - the repository.
	 * @param {string} options.id - the created change id.
	 * @param {object|undefined} options.entry - the plan entry it came from.
	 * @param {number} options.maxIterations - rounds the change gets.
	 * @param {string} options.plannerSessionId - the session that created it.
	 * @returns {Promise<string>} a warning, or '' when the change is clean.
	 */
	async #register({ openspec, projectPath, id, entry, maxIterations, plannerSessionId }) {
		const changeDir = openspec.changeDir(id);
		const tasks = readTasks(changeDir);
		const warnings = [];
		if (tasks.total === 0) {
			// The loop counts checkboxes; a change without any is one the loop will
			// refuse to run. That is worth saying at creation time, while the agent
			// that wrote it is still the obvious thing to fix.
			warnings.push('它的 `tasks.md` 里没有 `- [ ]` 复选框，迭代循环没法统计进度，请补上再开始。');
		}

		// The plugin did not write these files and cannot vouch for their shape, so
		// the only honest thing it can add is the CLI's own verdict — recorded on the
		// change, where the page already renders it. This is the check that used to
		// be a lint over a plan the plugin was about to render; now that the agent
		// renders it, running the real validator is the part that still means
		// something.
		let validation = '';
		try {
			validation = (await openspec.validate(id)).trim();
		} catch (error) {
			if (error instanceof OpenspecError) {
				validation = String(error.detail?.stderr ?? '').trim() || error.message;
				warnings.push(`openspec validate 未通过：${validation.split('\n').slice(-2).join(' ')}`);
			} else {
				warnings.push(`openspec validate 无法执行：${String(error)}`);
			}
		}

		const summary = readFileSync(join(changeDir, 'proposal.md'), 'utf8');
		// Keep only what the page shows: the first heading paragraph. The full text
		// stays in the file, where the loop and the user can both read it.
		const excerpt = summary.replace(/^#[^\n]*\n+/, '').trim().slice(0, 400);

		this.store.mutate(() => {
			const record = this.store.ensure(projectPath, id, {
				title: entry?.title ?? id,
				summary: entry?.summary ?? excerpt,
				maxIterations,
				plannerSessionId,
			});
			record.title = entry?.title ?? record.title ?? id;
			record.summary = entry?.summary ?? excerpt;
			record.maxIterations = maxIterations;
			record.tasksTotal = tasks.total;
			record.tasksDone = tasks.done;
			record.validation = validation;
			if (warnings.length > 0) record.note = warnings.join(' ');
			record.updatedAt = Date.now();
			record.log = [
				...(record.log ?? []),
				{
					round: 0,
					kind: 'split',
					status: 'ok',
					startedAt: Date.now(),
					finishedAt: Date.now(),
					tasksDone: tasks.done,
					tasksTotal: tasks.total,
					note: `由需求拆分创建（用户确认后由 \`${CREATE_SKILL}\` 技能落盘）`,
				},
			].slice(-50);
		});
		return warnings.join(' ');
	}

	/**
	 * Re-read the task tally of some changes from the CLI.
	 *
	 * @param {string} projectPath - the project directory.
	 * @param {string[]} [only] - ids to refresh; every recorded change when omitted.
	 * @returns {Promise<void>} resolves once the store is up to date.
	 */
	async refreshTasks(projectPath, only) {
		const openspec = new Openspec({ projectPath, command: this.commandFor(projectPath), log: this.log });
		if (!openspec.available) return;
		const records = this.store.changes(projectPath).filter((record) => only === undefined || only.includes(record.id));
		if (records.length === 0) return;
		let report;
		try {
			report = await openspec.list();
		} catch (error) {
			this.log(`读取 openspec 进度失败：${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const byName = new Map((report.changes ?? []).map((change) => [change.name, change]));
		const now = Date.now();
		this.store.mutate((document) => {
			for (const record of document.projects[projectPath]?.changes ?? []) {
				if (only !== undefined && !only.includes(record.id)) continue;
				const found = byName.get(record.id);
				if (found === undefined) continue;
				record.tasksTotal = Number.isFinite(found.totalTasks) ? found.totalTasks : record.tasksTotal;
				record.tasksDone = Number.isFinite(found.completedTasks) ? found.completedTasks : record.tasksDone;
				record.updatedAt = now;
			}
		});
	}
}

/** Ids already in use in a project: recorded changes plus whatever is on disk. */
export function takenIds(store, projectPath) {
	return [...new Set([...store.changes(projectPath).map((record) => record.id), ...changeIdsOnDisk(projectPath)])];
}
