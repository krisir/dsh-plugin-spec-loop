/**
 * The page's client-side state: one polling read plus the mutations that follow
 * it.
 *
 * Two decisions are worth naming.
 *
 * **The poll rate is derived, not chosen.** When a discussion or a round is in
 * flight the page re-reads every few seconds, because that is when the numbers
 * move; when nothing is running it backs off, because a list that is not changing
 * does not need to be fetched. That keeps the page live without making an idle
 * tab a busy loop.
 *
 * **A hidden tab stops polling.** The host is a local process and the page may sit
 * open for hours behind other windows; a background tab that keeps asking is pure
 * waste. Coming back into view re-reads immediately, so the user never sees stale
 * numbers.
 */

/**
 * Read and mutate the host's snapshot.
 *
 * @param {string} sessionId - the session the page is showing.
 * @returns {object} the state, the errors, and the actions.
 */
function useLoopState(sessionId) {
	const [state, setState] = React.useState(null);
	const [loadError, setLoadError] = React.useState('');
	const [actionError, setActionError] = React.useState('');
	const [actionNote, setActionNote] = React.useState('');
	const [busy, setBusy] = React.useState(false);
	const [tick, setTick] = React.useState(0);

	/** Force an immediate re-read. */
	const reload = React.useCallback(() => setTick((value) => value + 1), []);

	React.useEffect(() => {
		if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
		let cancelled = false;
		let timer;
		let controller = new AbortController();

		const schedule = (delay) => {
			timer = setTimeout(run, delay);
		};

		const busyNow = (snapshot) => {
			if (snapshot === null) return true;
			// A discussion counts as active: the agent is thinking between turns, and
			// the plan appears in the panel without the user reloading to find it.
			if (snapshot.discussion !== null && snapshot.discussion !== undefined) return true;
			return (snapshot.changes ?? []).some((change) => change.active === true);
		};

		const run = async () => {
			controller = new AbortController();
			let snapshot = null;
			try {
				snapshot = await fetchState(sessionId, controller.signal);
			} catch (error) {
				if (cancelled || error?.name === 'AbortError') return;
				setLoadError(error instanceof Error ? error.message : String(error));
				schedule(POLL_IDLE_MS);
				return;
			}
			if (cancelled) return;
			setLoadError('');
			setState(snapshot);
			const hidden = typeof document !== 'undefined' && document.hidden === true;
			const delay = busyNow(snapshot) ? (hidden ? POLL_ACTIVE_MS * 4 : POLL_ACTIVE_MS) : POLL_IDLE_MS;
			schedule(delay);
		};

		schedule(0);
		const onVisible = () => {
			if (typeof document !== 'undefined' && document.hidden !== true) {
				clearTimeout(timer);
				schedule(0);
			}
		};
		if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			controller.abort();
			if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
		};
	}, [sessionId, tick]);

	/**
	 * Run one mutation, folding its snapshot back in and surfacing its failure.
	 *
	 * Every call takes `{ state }`, so a mutation never needs a follow-up read to
	 * show its own effect: the page updates the instant the host answers.
	 *
	 * @param {(sessionId: string) => Promise<object>} operation - the call.
	 * @param {object} [options] - reporting options.
	 * @param {string | ((result: object) => string)} [options.note] - a message to
	 *   show on success, or a function of the response when what to say depends on
	 *   it — a confirm that reports warnings reads differently from one that did not.
	 * @returns {Promise<object | undefined>} the host's response.
	 */
	const act = React.useCallback(
		async (operation, options = {}) => {
			if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
			setBusy(true);
			setActionError('');
			setActionNote('');
			try {
				const result = await operation(sessionId);
				if (result !== null && typeof result === 'object' && result.state !== undefined) setState(result.state);
				const note = typeof options.note === 'function' ? options.note(result) : options.note;
				if (typeof note === 'string' && note.length > 0) setActionNote(note);
				return result;
			} catch (error) {
				setActionError(error instanceof Error ? error.message : String(error));
				return undefined;
			} finally {
				setBusy(false);
			}
		},
		[sessionId],
	);

	return {
		state,
		loadError,
		actionError,
		actionNote,
		busy,
		reload,
		act,
		clearActionError: React.useCallback(() => setActionError(''), []),
		clearActionNote: React.useCallback(() => setActionNote(''), []),
	};
}
