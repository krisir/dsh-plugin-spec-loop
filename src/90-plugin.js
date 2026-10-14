/**
 * Plugin entry: dictionaries, the stylesheet, and the view registration.
 *
 * Registration layout: one entry in `conversation.view`, the session-scoped list
 * the shell renders one at a time. It already holds `chat` (order 0),
 * `trajectory` (order 10) and the task queue (order 20), so this takes order 30
 * and sits fourth — beside them rather than in either of their cells.
 *
 * Everything the page shows comes from the host half over one HTTP route, and
 * the page re-reads it on a poll. The truth — what a change's task tally is,
 * which rounds ran, what the round budget is — lives on the host, because a
 * browser tab is not a loop.
 */

/** Cordis client services this plugin's `apply` waits for. */
const inject = ['slots', 'locale'];

/**
 * Client plugin body.
 * @param {object} ctx - the client root context.
 */
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'spec-loop: dictionaries');
	ctx.effect(() => installStyles(), 'spec-loop: stylesheet');

	// Reading `uiWorkspace` optionally rather than injecting it is deliberate. It
	// is what turns a change's session chip into a jump to that session, and the
	// session is where you actually watch a round happen — but a shell without the
	// workspace domain should lose the jump, not the whole page. So the capability
	// is probed, and the chip falls back to copying the id.
	//
	// The probe is a function rather than a boolean read once here, because this
	// plugin declares only `slots` and `locale`: `ui-workspace` may well apply
	// *after* it, and a value captured now would pin the answer to whoever happened
	// to be first. Asking at render time instead makes the chip correct whenever it
	// is looked at, and the page re-renders on every poll.
	const workspace = () => ctx.get?.('uiWorkspace');
	const canOpenSession = () => typeof workspace()?.openSession === 'function';
	const openSession = (id) => {
		const ui = workspace();
		if (typeof ui?.openSession !== 'function') return false;
		try {
			ui.openSession(id);
			return true;
		} catch {
			// A navigation the shell refuses leaves the chip to its fallback.
			return false;
		}
	};

	// `label` is what the shell projects into the tab row; without it the tab would
	// read as the raw slot id. `inject` receives the session id, which is what makes
	// the page a *project's* page: the id travels with every request and the Host
	// resolves it to a directory, so the page never has to know — or be trusted
	// with — a path of its own.
	const label = ctx.locale.bind(NS);
	ctx.slots.inject('conversation.view', () =>
		ctx.slots.register(
			{
				name: 'conversation.view',
				id: VIEW_ID,
				order: 30,
				locale: NS,
				label: () => label('view.label'),
				inject: (sessionId) => ({ sessionId, openSession, canOpenSession }),
			},
			SpecLoopPage,
		),
	);
}
