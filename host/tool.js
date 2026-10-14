/**
 * The `spec_loop_propose` tool: how an agent hands over a plan.
 *
 * A tool rather than a file, for three reasons. The agent gets an immediate,
 * specific answer — accepted, and here is what was wrong — instead of writing
 * into the void and hoping a later step parses it. The payload is structured by
 * construction, so there is no "the model printed prose where JSON was expected"
 * failure mode. And the call is visible in the transcript, which is where the
 * user is looking while the discussion happens.
 *
 * The tool cannot create changes. It writes a pending proposal into the store and
 * nothing else; creation goes through the user's confirm action.
 *
 * The definition is a plain object rather than a `defineTool({...})` result
 * because `@deepseek-ai/dsh-tools` is not resolvable from a plugin installed in
 * the profile — the runtime packages live in the application's own module graph.
 * `ctx.tools.register` accepts a pre-built definition, and `defineTool` is only
 * the ergonomic wrapper that turns a parameter *spec* into JSON Schema. Writing
 * the JSON Schema directly keeps this package dependency-free, which is what
 * lets it load in any composition at all.
 *
 * @module dsh-plugin-spec-loop/tool
 */

import { parseTaskText } from './openspec.js';
import { lintEntry, normalizeProposal, takenIds, toKebab } from './proposal.js';
import { DRAFT_STATUS, newProposalEntry } from './state.js';

/** The tool the discussion prompt tells the agent to call. */
export const TOOL_NAME = 'spec_loop_propose';

/** The JSON Schema of the tool's arguments, in the runtime's supported subset. */
const PARAMETERS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		changes: {
			type: 'array',
			description: 'The proposed OpenSpec changes, in the order they should be implemented.',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					id: {
						type: 'string',
						description: 'kebab-case change id, lowercase English with hyphens, e.g. "add-dark-mode".',
					},
					title: { type: 'string', description: 'One-line title, in the language the discussion is happening in.' },
					summary: {
						type: 'string',
						description:
							'Two or three sentences: what this change does and why it is a separate change. Prefix with "依赖：<id>" when it depends on another entry.',
					},
					proposal: { type: 'string', description: 'Full Markdown content of proposal.md.' },
					specs: {
						type: 'array',
						description: 'One entry per capability this change adds or modifies. Empty when it changes no external behaviour.',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								capability: { type: 'string', description: 'Capability path, e.g. "ui/theming".' },
								content: { type: 'string', description: 'Full Markdown content of spec.md.' },
							},
							required: ['capability', 'content'],
						},
					},
					design: { type: 'string', description: 'Full Markdown content of design.md. Keep it short unless the change is genuinely complex.' },
					tasks: {
						type: 'array',
						description:
							'The task groups. Do NOT write markdown checkboxes or numbering — the plugin generates "- [ ] 1.1 …" so the loop can count progress.',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								group: { type: 'string', description: 'Group heading, e.g. "后端".' },
								items: { type: 'array', items: { type: 'string' }, description: 'One short imperative task per entry.' },
							},
							required: ['items'],
						},
					},
				},
				required: ['id', 'title', 'tasks'],
			},
		},
	},
	required: ['changes'],
};

/** The JSON Schema of the tool's value. */
const OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		status: { type: 'string', description: 'accepted when the plan is waiting for confirmation.' },
		accepted: { type: 'number' },
		dropped: { type: 'number' },
		problems: { type: 'array', items: { type: 'string' } },
		message: { type: 'string' },
	},
	required: ['status', 'accepted', 'message'],
};

/**
 * A compact view of a proposal for the page.
 *
 * The artifact bodies stay on the host: the snapshot is polled every few seconds
 * while the page is open, and shipping tens of kilobytes of Markdown on every
 * tick to render a checklist would be waste. What the user reviews here is what
 * they can act on — the title, the summary, and the tasks the loop will run.
 *
 * @param {object} draft - the stored draft.
 * @returns {object | null} the view, or null when nothing is proposed.
 */
export function describeProposal(draft) {
	if (draft?.status !== DRAFT_STATUS.proposed || draft.proposal === undefined) return null;
	return {
		at: draft.proposal.at,
		entries: draft.proposal.entries.map((entry) => {
			const tasks = parseTaskText(entry.tasks);
			return {
				id: entry.id,
				title: entry.title,
				summary: entry.summary,
				include: entry.include !== false,
				tasksTotal: tasks.total,
				tasks: tasks.items,
				specs: entry.specs.map((spec) => spec.capability),
				problems: lintEntry(entry),
			};
		}),
		dropped: draft.dropped ?? [],
	};
}

/**
 * Build the tool definition `ctx.tools.register` accepts.
 *
 * @param {object} options - construction options.
 * @param {object} options.store - the durable store.
 * @param {(sessionId: string) => string | undefined} options.projectOfSession - session → project directory.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @returns {object} the tool definition.
 */
export function createProposeTool({ store, projectOfSession, log = () => {} }) {
	/** Answer the model without changing anything. */
	const refuse = (message) => ({ status: 'refused', accepted: 0, dropped: 0, problems: [], message });

	return {
		name: TOOL_NAME,
		description:
			'Hand a requirement split over to the user for confirmation. Call this once the discussion has settled ' +
			'what the change set should be. It does NOT create anything: it records the plan so the user can review, ' +
			'edit and confirm it, and creates the OpenSpec changes only when they do. Submitting again replaces the ' +
			'pending plan, which is how a revision is requested.',
		parameters: PARAMETERS,
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: value.message }],
		},
		execute(args, exec) {
			const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id;
			if (typeof sessionId !== 'string' || sessionId.length === 0) {
				log(`${TOOL_NAME} was called without a resolvable session`);
				return refuse('无法确定这次调用来自哪个会话，计划没有被保存。');
			}
			const draft = store.draft(sessionId);
			if (draft === undefined) {
				return refuse(
					'当前会话没有讨论中的需求，计划没有被保存。请让用户先用 `/spec <需求>` 开始一次拆分讨论。',
				);
			}

			// Prefer the directory recorded when the discussion opened. The session
			// header is re-read as a fallback because a draft can outlive the store
			// entry it was built from, and a plan aimed at no project is worse than
			// one aimed at the session's current one.
			const projectPath = draft.projectPath || projectOfSession(sessionId) || '';
			if (projectPath.length === 0) {
				return refuse('这个会话没有工作目录，无法确定要在哪个项目里创建 change，计划没有被保存。');
			}

			const { entries, dropped, filled } = normalizeProposal(args, takenIds(store, projectPath));
			if (entries.length === 0) {
				const reasons = dropped.map((entry) => entry.reason).join('；');
				return {
					status: 'rejected',
					accepted: 0,
					dropped: dropped.length,
					problems: dropped.map((entry) => `${entry.id ?? '(无 id)'}：${entry.reason}`),
					message:
						'计划里没有任何可用的 change，没有被保存。' +
						(dropped.length > 0 ? `原因：${reasons}。` : '`changes` 是空的。') +
						'请修正后重新调用这个工具。',
				};
			}

			const problems = entries.flatMap((entry) => lintEntry(entry).map((problem) => `${entry.id}：${problem}`));
			store.saveDraft({
				...draft,
				projectPath,
				status: DRAFT_STATUS.proposed,
				proposal: { entries: entries.map(newProposalEntry), at: Date.now() },
				dropped,
			});
			log(`proposal for ${sessionId}: ${entries.length} change(s), ${problems.length} lint problem(s)`);

			const stock = entries.map((entry) => `  - ${toKebab(entry.id)}`).join('\n');
			const lines = [
				`计划已提交：${entries.length} 个 change，正在等用户确认。**现在什么都还没有创建。**`,
				'',
				stock,
			];
			if (dropped.length > 0) {
				lines.push('', `有 ${dropped.length} 个条目被丢弃：`);
				for (const entry of dropped) lines.push(`  - ${entry.id ?? '(无 id)'}：${entry.reason}`);
			}
			if (filled.length > 0) {
				lines.push(
					'',
					`${filled.join('、')} 没有给 proposal.md，已经用 schema 模板占位，迭代时再补内容。`,
				);
			}
			if (problems.length > 0) {
				lines.push('', '下面这些地方可能会让 `openspec validate` 不通过，请顺手修掉后重新提交：');
				for (const problem of problems) lines.push(`  - ${problem}`);
			}
			lines.push(
				'',
				'接下来不要再创建任何文件。请用一两句话向用户说明你打算怎么拆、以及你不确定的地方，',
				'然后等用户在页面上确认或运行 `/spec apply`。',
			);
			return {
				status: 'accepted',
				accepted: entries.length,
				dropped: dropped.length,
				problems,
				message: lines.join('\n'),
			};
		},
	};
}
