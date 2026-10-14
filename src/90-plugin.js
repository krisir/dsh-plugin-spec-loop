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
				inject: (sessionId) => ({ sessionId }),
			},
			SpecLoopPage,
		),
	);
}
