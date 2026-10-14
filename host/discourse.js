/**
 * The `/spec` command: its grammar, and the prompts the discussion runs on.
 *
 * A command handler runs directly against an agent and cannot itself talk to the
 * model — its return value is rendered in the UI and never enters model history.
 * So `/spec <requirement>` does two things: it records the requirement durably,
 * and it submits **one** user message that opens the discussion. Every later
 * round is an ordinary conversation turn the user drives by talking.
 *
 * Creation is deliberately not reachable from here. The agent can only propose
 * through the `spec_loop_propose` tool; `apply` — the one path that writes into
 * the repository — is a user action, either `/spec apply` or the page's confirm
 * button. That is what makes "confirm first, then create" a property of the
 * system instead of a request in a prompt.
 *
 * @module dsh-plugin-spec-loop/discourse
 */

import { renderProposalRules } from './proposal.js';

/** The slash command this plugin owns. */
export const COMMAND_NAME = 'spec';

/** What the command picker shows beside the name. */
export const COMMAND_DESCRIPTION = 'Discuss a requirement, then split it into OpenSpec changes on confirmation';

/** The input hint the composer shows after `/spec`. */
export const COMMAND_HINT = '[<需求>|plan|apply|cancel|list]';

/**
 * The words that mean a control action instead of a requirement.
 *
 * Matching the whole input is what keeps `/spec 帮我修一下 plan 的解析` a
 * requirement: only a bare word is a control. The Chinese aliases exist because
 * the likeliest user of this command is not going to switch to English to
 * confirm something.
 */
const CONTROLS = new Map([
	['status', 'status'],
	['状态', 'status'],
	['plan', 'plan'],
	['计划', 'plan'],
	['apply', 'apply'],
	['confirm', 'confirm'],
	['确认', 'apply'],
	['cancel', 'cancel'],
	['discard', 'cancel'],
	['取消', 'cancel'],
	['list', 'list'],
	['列表', 'list'],
]);

/**
 * Parse the text after `/spec`.
 *
 * @param {unknown} rawInput - everything after the command name, verbatim.
 * @returns {{ kind: string, requirement?: string }} the action to take. `kind` is
 *   one of `status`, `plan`, `apply`, `cancel`, `list`, or `start` — the last
 *   carrying the requirement in `requirement`.
 */
export function parseSpecCommand(rawInput) {
	const input = String(rawInput ?? '').trim();
	if (input.length === 0) return { kind: 'status' };
	const control = CONTROLS.get(input.toLowerCase());
	if (control !== undefined) return { kind: control };
	return { kind: 'start', requirement: input };
}

/**
 * Build the message that opens the discussion.
 *
 * The whole point of the command is that this is a *conversation*, so the prompt
 * asks for questions rather than a plan: an agent that plans immediately is the
 * one-shot flow with extra ceremony. It also carries the artifact contract, so
 * the format rules are stated once, up front, where the agent will read them.
 *
 * @param {object} options - prompt inputs.
 * @param {string} options.requirement - what the user asked for.
 * @param {string} options.projectPath - the repository root.
 * @param {string} options.openspecRoot - the OpenSpec root.
 * @param {string[]} options.existingIds - change ids already present.
 * @returns {string} the prompt.
 */
export function renderKickoffPrompt({ requirement, projectPath, openspecRoot, existingIds }) {
	const existing = existingIds.length > 0 ? existingIds.join(', ') : '（还没有任何 change）';
	return [
		'用户提出了一个需求。**这一步只是讨论，不创建任何 change。**',
		'',
		'# 需求',
		'',
		requirement.trim(),
		'',
		'# 环境',
		'',
		`- 仓库根目录：${projectPath}`,
		`- OpenSpec 根目录：${openspecRoot}`,
		`- 已存在的 change（不要重名）：${existing}`,
		'',
		'# 这一轮要做的',
		'',
		'1. **先读仓库再提问。** 看 `openspec/config.yaml`（项目上下文与产物规则）、',
		'   `openspec/specs/` 下已有的 spec、以及需求涉及的代码目录。问题要建立在项目实际的',
		'   样子之上，不要问那些读一眼就知道的事。',
		'2. **一次只问最关键的 2～4 个问题**，不要一口气抛一堆。优先问会改变拆分结果的事：',
		'   范围边界、优先级、要拆成几个、有没有不能动的部分、怎么算做完了。',
		'3. 用户回答后如果还有歧义就继续问。**只有当你已经能说清拆分时才提交计划**，不要为了',
		'   显得勤快而过早提交。如果这个需求本来就已经足够明确、没什么可问的，那就直接用一两句话',
		'   说明你打算怎么拆，然后提交计划。',
		'4. 提交计划的方式是调用 `spec_loop_propose` 工具。',
		'',
		'# 硬性规则',
		'',
		'- **不要创建任何 change，不要写 `openspec/changes/` 下的任何文件。** 提交计划就够了 ——',
		'  落盘要等用户在页面上或 `/spec apply` 明确确认之后，由插件来做。',
		'- 提交计划前不要问"要不要我提交计划"，除非你确实拿不准范围。',
		'- 拆 1～6 个 change。需求本来就小就只拆 1 个，不要为了凑数硬拆。',
		'',
		renderProposalRules(),
	].join('\n');
}

/**
 * Build the message a `/spec plan` nudge sends.
 *
 * The artifact contract was already stated in the kickoff message and is still in
 * context, so this stays short on purpose: repeating a page of rules buries the
 * one instruction that matters.
 *
 * @param {object} options - prompt inputs.
 * @param {string} options.requirement - the requirement under discussion.
 * @returns {string} the prompt.
 */
export function renderPlanNudge({ requirement }) {
	return [
		'用户让你现在就把当前的理解整理成计划。',
		'',
		`讨论的需求是：${requirement.trim()}`,
		'',
		'请调用 `spec_loop_propose` 工具提交计划，格式按前面那条消息里的约定。**不要创建任何',
		'change，也不要写 `openspec/changes/` 下的文件** —— 用户确认后插件才会落盘。',
		'',
		'如果还有拿不准的地方，就在提交计划的同时用一两句话把不确定的点列出来，让用户在确认时',
		'一起看。不要因为不确定就无限提问。',
	].join('\n');
}

/**
 * The text `/spec` answers with: where the discussion stands and what to do next.
 *
 * @param {object} options - state inputs.
 * @param {object | undefined} options.draft - the session's draft, when there is one.
 * @param {string | undefined} options.projectPath - the session's project.
 * @param {number} options.changeCount - how many changes the project already has.
 * @returns {string} the status text.
 */
export function renderStatus({ draft, projectPath, changeCount }) {
	const lines = [];
	if (draft === undefined) {
		lines.push('当前会话还没有讨论中的需求。');
		lines.push('');
		lines.push(`用法：/spec <需求> 开始讨论；/spec 看状态；/spec list 看已有 change。`);
		if (projectPath === undefined) {
			lines.push('');
			lines.push('注意：这个会话还没有工作目录，插件无法确定要在哪个项目里操作 openspec。');
		} else {
			lines.push('');
			lines.push(`当前项目：${projectPath}（已有 ${changeCount} 个 change）`);
		}
		return lines.join('\n');
	}

	lines.push(`讨论中的需求：${draft.requirement.trim()}`);
	lines.push(`状态：${draft.status === 'proposed' ? '计划已提交，等你确认' : '讨论中'}`);
	if (draft.status === 'proposed') {
		const entries = draft.proposal?.entries ?? [];
		const selected = entries.filter((entry) => entry.include !== false).length;
		lines.push(`计划：${entries.length} 个 change，已勾选 ${selected} 个`);
		for (const entry of entries) {
			lines.push(`  ${entry.include === false ? '[ ]' : '[x]'} ${entry.id} — ${entry.title}`);
		}
		lines.push('');
		lines.push('下一步：在页面上勾选/改名后点「确认创建」，或者直接 /spec apply。');
		lines.push('放弃这次讨论用 /spec cancel。');
	} else {
		lines.push('');
		lines.push('继续跟 agent 讨论就可以。想让它现在就出计划，用 /spec plan。');
		lines.push('放弃这次讨论用 /spec cancel。');
	}
	return lines.join('\n');
}

/**
 * The text `/spec list` answers with.
 *
 * @param {object[]} changes - the project's change records.
 * @returns {string} the list text.
 */
export function renderChangeList(changes) {
	if (changes.length === 0) return '这个项目里还没有任何 change。用 /spec <需求> 开始。';
	return [
		`共 ${changes.length} 个 change：`,
		...changes.map((change) => {
			const progress = change.tasksTotal > 0 ? ` ${change.tasksDone}/${change.tasksTotal}` : '';
			const rounds = change.maxIterations === undefined ? '' : ` 轮次 ${change.iterations}/${change.maxIterations}`;
			return `  ${change.id} [${change.status}]${progress}${rounds} — ${change.title}`;
		}),
	].join('\n');
}
