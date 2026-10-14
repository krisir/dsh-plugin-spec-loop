/**
 * Requirement → changes: the proposal half of the plugin.
 *
 * The split is done by an agent, not by a parser: deciding where one change ends
 * and the next begins needs the repository — its conventions, its existing
 * specs, its config rules — and that is exactly what an agent with file tools
 * can read and a regex cannot.
 *
 * What the plugin keeps control of is the *shape* of the result. The agent hands
 * over a plan through the `spec_loop_propose` tool, and this module validates it,
 * sanitizes the ids, renders the task list into the checkbox format the loop
 * counts, creates the change directories through the OpenSpec CLI, writes the
 * artifacts, and validates each change. So a hallucinated layout cannot put
 * malformed files into `openspec/changes/`, and the user gets a specific
 * complaint instead of a silently broken change.
 *
 * Nothing here writes anything until the user confirms. The agent proposes, this
 * module normalizes and lints, and `apply()` — reached only from the user's own
 * confirm action — is what touches the repository.
 *
 * @module dsh-plugin-spec-loop/proposal
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Openspec, OpenspecError, changeIdsOnDisk } from './openspec.js';

/** The four artifact templates of the default `spec-driven` schema. */
const TEMPLATES = {
	proposal: `## Why

## What Changes

## Capabilities

### New Capabilities
- \`<capability-path>\`: <这个能力覆盖什么>

### Modified Capabilities
- \`<existing-capability-path>\`: <改变了哪条需求>

## Impact
`,
	spec: `## Purpose

<新能力用一两句话说明这个能力是干什么的，50 字以上>

## ADDED Requirements

### Requirement: <需求名>
<需求正文，用 SHALL / MUST 表述可验证的约束>

#### Scenario: <场景名>
- **WHEN** <条件>
- **THEN** <预期结果>
`,
	design: `## Context

## Goals / Non-Goals

**Goals:**

**Non-Goals:**

## Decisions

## Risks / Trade-offs
`,
	tasks: `## 1. <任务分组名>

- [ ] 1.1 <任务描述>
- [ ] 1.2 <任务描述>

## 2. <任务分组名>

- [ ] 2.1 <任务描述>
`,
};

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
 * Render grouped task items into the `tasks.md` the loop counts.
 *
 * The agent supplies the items, not the markdown, because the loop's progress
 * accounting depends on every task being a `- [ ] X.Y …` line — and the one
 * thing a model reliably gets wrong when asked for markdown is exactly that.
 * Numbering is assigned here so the ids are always dense and ordered.
 *
 * @param {Array<{ group?: unknown, items?: unknown }>} groups - the proposed groups.
 * @returns {string} the markdown, or '' when there is nothing usable.
 */
export function renderTaskMarkdown(groups) {
	const sections = [];
	let section = 0;
	for (const raw of Array.isArray(groups) ? groups : []) {
		if (raw === null || typeof raw !== 'object') continue;
		const items = (Array.isArray(raw.items) ? raw.items : [])
			.map((item) => (typeof item === 'string' ? item.trim() : ''))
			.filter((item) => item.length > 0);
		if (items.length === 0) continue;
		section += 1;
		const group = typeof raw.group === 'string' && raw.group.trim().length > 0 ? raw.group.trim() : `任务组 ${section}`;
		const lines = items.map((item, index) => `- [ ] ${section}.${index + 1} ${item}`);
		sections.push(`## ${section}. ${group}\n\n${lines.join('\n')}`);
	}
	return sections.length === 0 ? '' : `${sections.join('\n\n')}\n`;
}

/**
 * Check one normalized entry for the mistakes the OpenSpec validator rejects.
 *
 * This runs while the plan is still a proposal, so a plan that would fail
 * validation is flagged in the review step instead of after the user has already
 * confirmed it. It is a lint, not a proof: `openspec validate` still runs on the
 * created change, and its verdict is what the change record reports.
 *
 * @param {object} entry - a normalized entry.
 * @returns {string[]} one message per problem found.
 */
export function lintEntry(entry) {
	const problems = [];
	if (entry.title.trim().length === 0) problems.push('没有标题');
	if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) problems.push(`id "${entry.id}" 不是合法的 kebab-case`);
	if (!/[-*]\s*\[[ xX]\]/.test(entry.tasks)) problems.push('tasks 里没有任何 `- [ ]` 复选框任务，迭代循环无法统计进度');
	if (entry.specs.length === 0) {
		// A change that alters no external behaviour is legitimate and gets
		// `skip_specs: true`; one that wrote a spec file but no requirements is not.
		return problems;
	}
	for (const spec of entry.specs) {
		const requirements = [...spec.content.matchAll(/^###\s+Requirement:\s*(.*)$/gm)];
		if (requirements.length === 0) {
			problems.push(`${spec.capability}：没有任何 \`### Requirement:\``);
			continue;
		}
		for (const [index, match] of requirements.entries()) {
			const start = match.index + match[0].length;
			const end = index + 1 < requirements.length ? requirements[index + 1].index : spec.content.length;
			if (!/^####\s+Scenario:/m.test(spec.content.slice(start, end))) {
				problems.push(`${spec.capability}：「${match[1].trim() || '(未命名)'}」下面没有 \`#### Scenario:\``);
			}
		}
	}
	return problems;
}

/**
 * Validate and normalize a raw plan into the entries the writer can use.
 *
 * Everything the model controls is treated as hostile input here: the id is
 * kebab-cased and de-duplicated, the artifact bodies must be strings, and an
 * entry with no usable tasks is dropped rather than created as a change the loop
 * can never finish.
 *
 * @param {object} plan - the tool arguments the agent sent.
 * @param {string[]} taken - ids already in use, which new ids must avoid.
 * @returns {{ entries: object[], dropped: object[], filled: string[] }} the accepted
 *   entries, the rejected ones, and the ids that got a template proposal.md.
 */
export function normalizeProposal(plan, taken) {
	const rawList = Array.isArray(plan?.changes) ? plan.changes : [];
	const used = new Set(taken);
	const entries = [];
	const dropped = [];
	/** Ids whose proposal.md fell back to the template, for the tool to report. */
	const filled = [];
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
		// The structured form is what the tool schema asks for; a raw markdown
		// string is accepted too, because a model that has already written the
		// file tends to paste the file.
		const tasks =
			typeof raw.tasks === 'string'
				? raw.tasks
				: renderTaskMarkdown(Array.isArray(raw.tasks) ? raw.tasks : raw.taskGroups);
		if (!/[-*]\s*\[[ xX]\]/.test(tasks)) {
			dropped.push({ id, reason: 'tasks 里没有任何 `- [ ]` 复选框任务，迭代循环无法统计进度' });
			continue;
		}
		const specs = (Array.isArray(raw.specs) ? raw.specs : [])
			.map((spec) => {
				if (spec === null || typeof spec !== 'object') return undefined;
				const capability = String(spec.capability ?? spec.path ?? '')
					.trim()
					.replace(/^\/+|\/+$/g, '');
				if (capability.length === 0 || typeof spec.content !== 'string' || spec.content.trim().length === 0) {
					return undefined;
				}
				return { capability, content: spec.content };
			})
			.filter((spec) => spec !== undefined);
		used.add(id);
		// An omitted proposal.md gets the schema's own template rather than an empty
		// file: the artifact is part of what makes a change a change, and a stub with
		// the right headings is something the loop can fill in, while a blank file is
		// something it has to notice first.
		const proposal = typeof raw.proposal === 'string' ? raw.proposal : '';
		if (proposal.trim().length === 0) filled.push(id);
		entries.push({
			id,
			title: typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title.trim() : id,
			summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
			proposal: proposal.trim().length === 0 ? TEMPLATES.proposal : proposal,
			design: typeof raw.design === 'string' ? raw.design : '',
			tasks,
			specs,
		});
	}
	return { entries, dropped, filled };
}

/**
 * The artifact contract the agent must follow, shared by every prompt that asks
 * for a plan so the rules cannot drift between the opener and the nudge.
 *
 * @returns {string} the rules as prompt text.
 */
export function renderProposalRules() {
	return [
		'# 计划要满足的格式',
		'',
		'用 `spec_loop_propose` 工具提交计划。每个 change 是：',
		'',
		'```json',
		'{',
		'  "id": "kebab-case-id（小写英文，连字符）",',
		'  "title": "一句话中文标题",',
		'  "summary": "两三句话：做什么、为什么它该独立成一个 change（有先后依赖就写「依赖：<id>」）",',
		'  "proposal": "proposal.md 的完整 Markdown",',
		'  "specs": [{ "capability": "capability-path", "content": "spec.md 的完整 Markdown" }],',
		'  "design": "design.md 的完整 Markdown",',
		'  "tasks": [{ "group": "任务分组名", "items": ["任务描述", "任务描述"] }]',
		'}',
		'```',
		'',
		'`tasks` 用上面这种分组结构，**不要自己写 `- [ ]` 和编号** —— 插件会按顺序生成',
		'`- [ ] 1.1 …` 这样的复选框，迭代循环就是靠它统计进度的。',
		'',
		'项目 schema 是 `spec-driven`（proposal → specs → design → tasks）。四个模板：',
		'',
		'## proposal.md',
		'```markdown',
		TEMPLATES.proposal + '```',
		'',
		'## specs/<capability-path>/spec.md',
		'```markdown',
		TEMPLATES.spec + '```',
		'',
		'## design.md',
		'```markdown',
		TEMPLATES.design + '```',
		'',
		'## tasks.md（由 `tasks` 结构生成，这里只是给你看最终形态）',
		'```markdown',
		TEMPLATES.tasks + '```',
		'',
		'# 硬性规则',
		'',
		'- 每个 `### Requirement:` 下面必须至少有一个 `#### Scenario:`（**正好四个井号**），',
		'  场景用 WHEN / THEN 写；新能力要带 `## Purpose`。插件会在你提交时立刻检查这一条，',
		'  不符合会被标出来。',
		'- 每个 change 必须能**独立实现、独立验证**，change 之间尽量不耦合。',
		'- 如果这个 change 确实不改变任何外部可见行为（纯重构、工具链、文档），就把 `specs`',
		'  写成空数组 `[]`，插件会给它的 `.openspec.yaml` 加上 `skip_specs: true`。',
		'  不要为了凑验证而编造需求。',
		'- `design.md` 只在确实需要时写实质内容（跨模块改动、新增外部依赖、数据模型变化、',
		'  有安全/性能/迁移复杂度）。简单 change 也保留文件，但可以简短。',
		'- 只提交计划，**不要自己创建 `openspec/changes/` 目录，也不要自己写这些文件** ——',
		'  建目录、落盘、校验都由插件在用户确认之后做。',
		'',
		'所有文档正文用中文（代码标识符、路径、命令保持原文）。',
	].join('\n');
}

/**
 * Write one validated entry into the repository as an OpenSpec change.
 *
 * @param {object} options - write inputs.
 * @param {Openspec} options.openspec - the bound CLI.
 * @param {object} options.entry - a normalized plan entry.
 * @returns {Promise<{ id: string, validation: string, warning: string }>} the outcome.
 */
async function writeChange({ openspec, entry }) {
	const created = await openspec.newChange(entry.id, entry.title);
	const changeId = typeof created?.change?.id === 'string' ? created.change.id : entry.id;
	const changeDir = openspec.changeDir(changeId);

	writeFileSync(join(changeDir, 'proposal.md'), ensureTrailingNewline(entry.proposal), 'utf8');
	writeFileSync(join(changeDir, 'tasks.md'), ensureTrailingNewline(entry.tasks), 'utf8');
	// design.md is optional in the schema, but writing it when the agent produced
	// one is more honest than dropping it: the artifact report then reads "written"
	// instead of "missing", and a later round can fill it in.
	if (entry.design.trim().length > 0) {
		writeFileSync(join(changeDir, 'design.md'), ensureTrailingNewline(entry.design), 'utf8');
	}
	for (const spec of entry.specs) {
		const specDir = join(changeDir, 'specs', ...spec.capability.split('/'));
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, 'spec.md'), ensureTrailingNewline(spec.content), 'utf8');
	}
	if (entry.specs.length === 0) {
		markSkipSpecs(changeDir);
	}

	let validation = '';
	let warning = '';
	try {
		validation = (await openspec.validate(changeId)).trim();
	} catch (error) {
		if (error instanceof OpenspecError) {
			validation = String(error.detail?.stderr ?? '').trim() || error.message;
			warning = `openspec validate 未通过：${validation.split('\n').slice(-2).join(' ')}`;
		} else {
			warning = `openspec validate 无法执行：${String(error)}`;
		}
	}
	return { id: changeId, validation, warning };
}

/** Append `skip_specs: true` to a change's metadata, once. */
function markSkipSpecs(changeDir) {
	const path = join(changeDir, '.openspec.yaml');
	let text = '';
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		text = '';
	}
	if (/skip_specs\s*:/.test(text)) return;
	const appended = text.endsWith('\n') || text.length === 0 ? text : `${text}\n`;
	writeFileSync(path, `${appended}skip_specs: true\n`, 'utf8');
}

/** Give an artifact a trailing newline, which every one of these documents has. */
function ensureTrailingNewline(text) {
	const value = typeof text === 'string' ? text : '';
	return value.endsWith('\n') ? value : `${value}\n`;
}

/**
 * The ids a new plan must avoid: the ones this list remembers plus the ones the
 * repository has, because the two drift as soon as somebody creates a change by
 * hand.
 *
 * @param {object} store - the durable store.
 * @param {string} projectPath - the project directory.
 * @returns {string[]} the taken ids.
 */
export function takenIds(store, projectPath) {
	return [...new Set([...store.changes(projectPath).map((record) => record.id), ...changeIdsOnDisk(projectPath)])];
}

/**
 * The proposal operations: a validated plan in, change records out.
 */
export class Proposals {
	/**
	 * @param {object} options - construction options.
	 * @param {object} options.store - the durable store.
	 * @param {(projectPath: string) => string} options.commandFor - the configured CLI command.
	 * @param {(message: string) => void} [options.log] - diagnostic sink.
	 */
	constructor({ store, commandFor, log = () => {} }) {
		this.store = store;
		this.commandFor = commandFor;
		this.log = log;
	}

	/**
	 * Ensure the project has an OpenSpec root, initializing it when it does not.
	 *
	 * @param {Openspec} openspec - the bound CLI.
	 * @returns {Promise<string>} the project root.
	 */
	async ensureInitialized(openspec) {
		const existing = openspec.root;
		if (existing !== undefined) return existing;
		if (!openspec.available) {
			throw new ProposalError(
				`找不到 openspec 命令（配置为 "${openspec.command}"）。请确认已安装 OpenSpec，或在插件设置里指定绝对路径。`,
			);
		}
		this.log(`${openspec.projectPath} 还没有 openspec 目录，执行 openspec init`);
		await openspec.init();
		const root = openspec.root;
		if (root === undefined) {
			throw new ProposalError(`openspec init 执行完了，但 ${openspec.projectPath} 下仍然没有 openspec/config.yaml`);
		}
		return root;
	}

	/**
	 * Create the confirmed entries as real OpenSpec changes.
	 *
	 * This is the only place in the plugin that creates changes, and it is reached
	 * from the user's confirm action alone. Everything it needs was validated when
	 * the plan was proposed, so a failure here is an environment problem — a
	 * missing CLI, a permission, a name already taken on disk.
	 *
	 * @param {object} options - the request.
	 * @param {string} options.projectPath - the repository to write into.
	 * @param {object[]} options.entries - the confirmed, normalized entries.
	 * @param {number} options.maxIterations - rounds each new change gets.
	 * @param {string} [options.plannerSessionId] - the session the plan came from.
	 * @returns {Promise<{ ids: string[], warnings: string[] }>} the outcome.
	 */
	async apply({ projectPath, entries, maxIterations, plannerSessionId = '' }) {
		if (entries.length === 0) throw new ProposalError('没有选中任何 change');
		const openspec = new Openspec({ projectPath, command: this.commandFor(projectPath), log: this.log });
		await this.ensureInitialized(openspec);

		const warnings = [];
		const ids = [];
		for (const entry of entries) {
			try {
				const written = await writeChange({ openspec, entry });
				ids.push(written.id);
				if (written.warning.length > 0) warnings.push(`${written.id}：${written.warning}`);
				this.store.mutate(() => {
					const record = this.store.ensure(projectPath, written.id, {
						title: entry.title,
						summary: entry.summary,
						maxIterations,
						plannerSessionId,
					});
					record.title = entry.title;
					record.summary = entry.summary;
					record.maxIterations = maxIterations;
					record.validation = written.validation.slice(0, 2000);
					record.updatedAt = Date.now();
					if (written.warning.length > 0) record.note = written.warning;
					record.log = [
						...(record.log ?? []),
						{
							round: 0,
							kind: 'split',
							status: 'ok',
							startedAt: Date.now(),
							finishedAt: Date.now(),
							tasksDone: 0,
							tasksTotal: 0,
							note: '由需求拆分创建（用户在确认后落盘）',
						},
					].slice(-50);
				});
			} catch (error) {
				warnings.push(`${entry.id}：创建失败 —— ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (ids.length === 0) {
			throw new ProposalError(`确认了 ${entries.length} 个 change，但一个都没能写进仓库。`, { warnings });
		}
		// Re-read progress for every new change, so the list shows real numbers
		// immediately instead of zeros until the next poll.
		await this.refreshTasks(projectPath, ids);
		return { ids, warnings };
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
