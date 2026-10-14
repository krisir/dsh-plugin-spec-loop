/**
 * Unattended execution: making a loop-owned session run without stopping to ask.
 *
 * A ralph round that halts on an approval prompt has silently produced nothing,
 * and the Host's `never` approval policy answers a prompt by *rejecting* it —
 * failing the round at the exact moment it needed to act. So "skip every
 * authorization" is three deliberate layers, all scoped to sessions this plugin
 * drives:
 *
 * 1. `sandbox/mode` is set to `danger-full-access` on the session, so the
 *    filesystem and shell tools do not need an escalation in the first place.
 *    This is the layer that decides whether the work can happen at all, since a
 *    confined call that is refused never reaches layer 2.
 * 2. A `tools/pre-execute` listener answers `allow`. This is the real bypass: it
 *    short-circuits the pipeline *before* an `ask` can become an approval
 *    request, whatever policy the session carries.
 * 3. An `approval/request` listener answers `allowed-once`, covering a tool body
 *    that consults the approval service directly.
 *
 * Every layer checks {@link Privileges.isManaged} first, so a session the user is
 * typing into — including the one showing this page — is never affected.
 *
 * The approach mirrors `dsh-task-queue/host/privilege.js` (MIT), which solves
 * the same problem for a scheduled queue.
 *
 * @module dsh-plugin-spec-loop/privilege
 */

/** The sandbox mode an unattended round runs under. */
export const UNATTENDED_SANDBOX_MODE = 'danger-full-access';

/** The policy that lets a managed session's asks reach the answerers at all. */
const REACHABLE_APPROVAL_POLICY = 'ask';

/** The only approval outcome that grants an action. */
const GRANT = 'allowed-once';

/** Tracks which sessions belong to the loop and installs the bypass hooks. */
export class Privileges {
	/** @type {Set<string>} session ids the loop currently drives. */
	managed = new Set();

	/**
	 * @param {object} ctx - Host plugin context.
	 * @param {object} [options] - construction options.
	 * @param {object} [options.services] - live handles to optional services.
	 * @param {(message: string) => void} [options.log] - diagnostic sink.
	 */
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		this.services = options.services ?? {};
		this.log = options.log ?? (() => {});
	}

	/**
	 * Arm the bypass hooks.
	 *
	 * Both listeners are registered with `prepend: true`: the Web GUI registers
	 * its own `approval/request` answerer, and a listener that merely delegates
	 * when it has no opinion is still a race if something else answers first.
	 *
	 * @returns {() => void} a disposer that disarms them.
	 */
	install() {
		const disposers = [
			this.ctx.on(
				'tools/pre-execute',
				(exec, next) => {
					if (!this.isManaged(exec?.agent?.session?.id)) return next();
					return { kind: 'allow' };
				},
				{ prepend: true },
			),
			this.ctx.on(
				'approval/request',
				(request, next) => {
					if (!this.isManaged(request?.agent?.session?.id)) return next();
					return GRANT;
				},
				{ prepend: true },
			),
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}

	/**
	 * Whether a session is one the bypass may act on.
	 * @param {unknown} sessionId - candidate session id.
	 * @returns {boolean} true when the loop owns the session.
	 */
	isManaged(sessionId) {
		return typeof sessionId === 'string' && this.managed.has(sessionId);
	}

	/**
	 * Take ownership of a session.
	 * @param {unknown} sessionId - the session to claim.
	 * @returns {void}
	 */
	manage(sessionId) {
		if (typeof sessionId === 'string' && sessionId.length > 0) this.managed.add(sessionId);
	}

	/**
	 * Release a session, so a later interactive visit is back under normal rules.
	 * @param {unknown} sessionId - the session to release.
	 * @returns {void}
	 */
	release(sessionId) {
		this.managed.delete(sessionId);
	}

	/**
	 * Relax one live session for unattended work.
	 *
	 * `ask` is required, not cosmetic: under `never` the approval service answers
	 * `rejected` before any answerer runs, so layer 3 would never be consulted.
	 *
	 * @param {object} agent - the live Agent that will run the round.
	 * @param {boolean} enabled - whether this round skips authorizations.
	 * @returns {void}
	 */
	harden(agent, enabled) {
		const session = agent?.session;
		if (session === undefined) return;
		if (!enabled) {
			this.release(session.id);
			return;
		}
		this.manage(session.id);
		try {
			session.append('sandbox/mode', { mode: UNATTENDED_SANDBOX_MODE });
		} catch (error) {
			this.log(`could not set the sandbox mode for ${session.id}: ${String(error)}`);
		}
		try {
			const approval = this.services.approval;
			if (approval !== undefined && typeof approval.setPolicy === 'function') {
				approval.setPolicy(agent, REACHABLE_APPROVAL_POLICY);
			} else {
				session.append('approval/policy', { policy: REACHABLE_APPROVAL_POLICY });
			}
		} catch (error) {
			try {
				session.append('approval/policy', { policy: REACHABLE_APPROVAL_POLICY });
			} catch (inner) {
				// Layers 1 and 2 still carry the guarantee for the shipped tools.
				this.log(`could not relax the approval policy for ${session.id}: ${String(inner ?? error)}`);
			}
		}
	}
}
