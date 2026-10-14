/**
 * The `/spec` command handler: the discussion's control surface.
 *
 * Every action here is a *user* action. The handler can open a discussion, ask
 * for a plan, confirm one, or throw one away — but the agent cannot reach any of
 * it, because the agent has no way to execute a command. That asymmetry is the
 * whole design: the model proposes through a tool, and only the person can say
 * "yes, create it".
 *
 * @module dsh-plugin-spec-loop/command
 */

import {
	COMMAND_DESCRIPTION,
	COMMAND_HINT,
	COMMAND_NAME,
	parseSpecCommand,
	renderChangeList,
	renderKickoffPrompt,
	renderPlanNudge,
	renderStatus,
} from './discourse.js';
import { Openspec, changeIdsOnDisk } from './openspec.js';
import { ProposalError } from './proposal.js';
import { DRAFT_STATUS, newDraft } from './state.js';

/** One command result the adapter renders outside model history. */
const ok = (text) => ({ kind: 'success', text });

/** One command failure the adapter renders outside model history. */
const fail = (text) => ({ kind: 'error', text });

/**
 * Build the `/spec` command definition.
 *
 * @param {object} options - construction options.
 * @param {object} options.store - the durable store.
 * @param {object} options.proposals - the proposal operations.
 * @param {object} options.sessions - the session seam.
 * @param {(sessionId: string) => string | undefined} options.projectOfSession - session → project directory.
 * @param {(projectPath: string) => string} options.commandFor - the configured CLI command.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @returns {object} the command definition for `ctx.commands.register`.
 */
export function createSpecCommand({ store, proposals, sessions, projectOfSession, commandFor, log = () => {} }) {
	/**
	 * Submit one discussion message without waiting for the turn.
	 *
	 * A failure here is reported to the user rather than thrown: the draft is
	 * already durable, so a session that cannot be reached is something they can
	 * retry by talking, not a reason to lose the requirement.
	 *
	 * @param {string} sessionId - the session to prompt.
	 * @param {string} text - the prompt.
	 * @param {string} kind - a short tag for the request id.
	 * @returns {Promise<string | undefined>} an error message, when there was one.
	 */
	const openTurn = async (sessionId, text, kind) => {
		try {
			await sessions.submit({ sessionId, text, requestId: `spec-loop-${kind}-${Date.now()}` });
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	};

	/**
	 * Open a discussion for one requirement.
	 *
	 * OpenSpec is initialized here rather than at creation time because the
	 * kickoff prompt has to name the OpenSpec root and the ids already taken, and
	 * because finding out that the CLI is missing is much cheaper now than after
	 * the user has spent ten rounds discussing a plan.
	 *
	 * @param {string} sessionId - the session the command came from.
	 * @param {string} requirement - what the user asked for.
	 * @returns {Promise<object>} the settled result.
	 */
	const startDiscussion = async (sessionId, requirement) => {
		const projectPath = projectOfSession(sessionId);
		if (projectPath === undefined) {
			return fail('这个会话还没有工作目录，插件无法确定要在哪个项目里操作 openspec。');
		}
		const openspec = new Openspec({ projectPath, command: commandFor(projectPath), log });
		let root;
		try {
			root = await proposals.ensureInitialized(openspec);
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error));
		}
		store.saveDraft(newDraft(sessionId, { projectPath, requirement }));
		const error = await openTurn(
			sessionId,
			renderKickoffPrompt({
				requirement,
				projectPath,
				openspecRoot: root,
				existingIds: changeIdsOnDisk(root),
			}),
			'start',
		);
		if (error !== undefined) {
			return fail(`需求已记下，但没能把消息发给会话：${error}。可以直接跟 agent 说要拆分这个需求。`);
		}
		log(`discussion opened for ${sessionId}: ${requirement.slice(0, 60)}`);
		return ok(
			[
				'已开始讨论这个需求。**现在还没有创建任何 change。**',
				'',
				'agent 会先读仓库、再问几个问题。你们聊清楚了，它会把计划提交上来，',
				'然后在页面上（或 `/spec apply`）确认之后才会落盘。',
				'',
				'现在就出计划：/spec plan　　放弃：/spec cancel　　看状态：/spec',
			].join('\n'),
		);
	};

	/**
	 * Create the confirmed entries.
	 *
	 * @param {string} sessionId - the session the command came from.
	 * @returns {Promise<object>} the settled result.
	 */
	const applyProposal = async (sessionId) => {
		const draft = store.draft(sessionId);
		if (draft === undefined || draft.status !== DRAFT_STATUS.proposed || draft.proposal === undefined) {
			return fail('现在还没有待确认的计划。先用 `/spec <需求>` 讨论，再让它提交计划。');
		}
		const entries = draft.proposal.entries.filter((entry) => entry.include !== false);
		if (entries.length === 0) return fail('一个 change 都没勾选，没什么可创建的。');
		let outcome;
		try {
			outcome = await proposals.apply({
				projectPath: draft.projectPath,
				entries,
				maxIterations: store.settings().ralphIterations,
				plannerSessionId: sessionId,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof ProposalError) log(`apply failed for ${sessionId}: ${message}`);
			return fail(`创建失败：${message}`);
		}
		store.clearDraft(sessionId);
		log(`applied ${outcome.ids.length} change(s) for ${sessionId}`);
		const lines = [
			`已创建 ${outcome.ids.length} 个 change：`,
			...outcome.ids.map((id) => `  - ${id}`),
			'',
			'接下来在页面上给它们设置轮数并开始迭代，或者用 `/spec list` 看进度。',
		];
		if (outcome.warnings.length > 0) {
			lines.push('', '有几点要注意：', ...outcome.warnings.map((warning) => `  - ${warning}`));
		}
		return ok(lines.join('\n'));
	};

	/**
	 * Run one command.
	 *
	 * @param {object} invocation - the adapter's invocation.
	 * @returns {Promise<object>} the settled result.
	 */
	const handler = async (invocation) => {
		const sessionId = invocation?.agent?.session?.id ?? invocation?.agent?.id;
		if (typeof sessionId !== 'string' || sessionId.length === 0) {
			return fail('无法确定这条命令来自哪个会话。');
		}
		const draft = store.draft(sessionId);
		const parsed = parseSpecCommand(invocation?.rawInput);
		// The draft records the directory the discussion opened in; a draft that
		// outlived its session entry still has one, so it wins.
		const path = draft?.projectPath || projectOfSession(sessionId);

		switch (parsed.kind) {
			case 'status':
				return ok(renderStatus({ draft, projectPath: path, changeCount: path === undefined ? 0 : store.changes(path).length }));

			case 'list':
				if (path === undefined) return fail('这个会话还没有工作目录，无法确定要看哪个项目的 change。');
				return ok(renderChangeList(store.changes(path)));

			case 'cancel':
				if (draft === undefined) return fail('当前会话没有讨论中的需求，没有可取消的东西。');
				store.clearDraft(sessionId);
				log(`discussion cancelled for ${sessionId}`);
				return ok('已取消。仓库里没有创建过任何 change，讨论内容还在会话历史里。');

			case 'plan': {
				if (draft === undefined) return fail('当前会话还没有讨论中的需求。先用 `/spec <需求>` 开始。');
				const error = await openTurn(sessionId, renderPlanNudge({ requirement: draft.requirement }), 'plan');
				if (error !== undefined) return fail(`没能把消息发给会话：${error}`);
				return ok('已让 agent 现在就把当前的理解整理成计划。它会用 `spec_loop_propose` 提交，然后在页面上确认。');
			}

			case 'apply':
				return applyProposal(sessionId);

			case 'confirm':
				return fail('确认之前请先把计划看完。在页面上勾选/改名后点「确认创建」，或者用 `/spec apply`。');

			case 'start':
				return startDiscussion(sessionId, parsed.requirement);

			default:
				return fail(`不认识的动作 ${parsed.kind}`);
		}
	};

	return {
		name: COMMAND_NAME,
		description: COMMAND_DESCRIPTION,
		input: { hint: COMMAND_HINT },
		handler,
	};
}
