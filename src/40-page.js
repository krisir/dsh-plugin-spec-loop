/**
 * The page itself.
 *
 * Layout is a header, a requirement composer, then the change list, with the
 * settings panel replacing the list rather than floating over it: this page owns
 * a whole conversation tab, so there is room to be plain about what is on screen.
 */

/**
 * A small status pill.
 * @param {object} props - `t` and the status.
 * @returns {object} the element.
 */
function StatusPill({ t, status }) {
	return h('span', { className: `sl-pill sl-tone-${toneOf(status)}` }, t(`status.${status}`));
}

/**
 * A thin progress bar with an accessible label.
 * @param {object} props - `done`, `total`, and the label.
 * @returns {object} the element.
 */
function ProgressBar({ done, total, label }) {
	const value = percent(done, total);
	return h(
		'div',
		{
			className: 'sl-bar',
			role: 'progressbar',
			'aria-valuemin': 0,
			'aria-valuemax': 100,
			'aria-valuenow': value,
			'aria-label': label,
		},
		h('div', {
			className: `sl-bar-fill${value >= 100 && total > 0 ? ' sl-bar-fill-ok' : ''}`,
			style: { width: `${value}%` },
		}),
	);
}

/**
 * A notice line.
 * @param {object} props - `tone` and children.
 * @returns {object} the element.
 */
function Notice({ tone, children }) {
	return h('div', { className: `sl-notice${tone ? ` sl-notice-${tone}` : ''}` }, children);
}

/**
 * Render one round-log entry.
 * @param {object} props - `t` and the entry.
 * @returns {object} the element.
 */
function LogEntry({ t, entry }) {
	const kind = entry.kind === 'split' ? t('log.split') : `${t('log.ralph')} #${entry.round}`;
	const tone =
		entry.status === 'ok' ? 'ok' : entry.status === 'error' ? 'error' : entry.status === 'timeout' ? 'warn' : '';
	return h(
		'div',
		{ className: `sl-log-entry${tone ? ` sl-log-entry-${tone}` : ''}` },
		h(
			'div',
			{ className: 'sl-log-head' },
			h('strong', null, kind),
			entry.status === 'ok' || entry.kind === 'split' ? null : h('span', { className: 'sl-hint' }, t(`log.${entry.status}`)),
			entry.kind === 'split'
				? null
				: h('span', { className: 'sl-hint' }, `${entry.tasksDone}/${entry.tasksTotal}`),
			h('span', { className: 'sl-hint sl-row-end' }, formatClock(entry.finishedAt || entry.startedAt)),
		),
		entry.note ? h('div', { className: 'sl-log-note' }, entry.note) : null,
	);
}

/**
 * One change card: status, progress, the actions that apply to it, and its log.
 * @param {object} props - `t`, `sessionId`, `change`, `loop`, the open state, and
 *   the session-navigation pair `openSession` / `canOpenSession`.
 * @returns {object} the element.
 */
function ChangeCard({ t, sessionId, change, loop, open, onToggle, openSession, canOpenSession }) {
	const [roundsDraft, setRoundsDraft] = React.useState(null);
	const [confirming, setConfirming] = React.useState(false);
	const [copied, setCopied] = React.useState(false);
	// Asked on every render rather than latched: the shell may gain the workspace
	// domain after this card first painted.
	const canJump = typeof canOpenSession === 'function' && canOpenSession() === true;

	const roundsValue = roundsDraft ?? String(change.maxIterations);
	const roundsDirty = roundsDraft !== null && Number.parseInt(roundsDraft, 10) !== change.maxIterations;
	const active = change.active === true;
	const done = change.status === 'done';
	const parked = change.status === 'queued';

	const saveRounds = () => {
		const value = Number.parseInt(roundsValue, 10);
		if (!Number.isFinite(value)) {
			setRoundsDraft(null);
			return;
		}
		void loop.act((id) => api.update(id, change.id, { maxIterations: value })).then(() => setRoundsDraft(null));
	};

	const copySession = () => {
		try {
			void navigator.clipboard?.writeText(change.sessionId);
			setCopied(true);
			setTimeout(() => setCopied(false), 1400);
		} catch {
			/* A clipboard that refuses simply does not confirm. */
		}
	};

	/**
	 * Reveal the session this change's rounds run in.
	 *
	 * Opening is the point of the chip — a round is an ordinary conversation and
	 * watching it is how you tell "working" from "stuck". Copying is only the
	 * fallback for a shell with no session navigation, so that the id is never
	 * stranded in a tooltip the way it was when this only copied.
	 */
	const revealSession = () => {
		if (canJump && typeof openSession === 'function') {
			if (openSession(change.sessionId) === true) return;
		}
		copySession();
	};

	return h(
		'div',
		{ className: 'sl-card sl-change' },
		h(
			'div',
			{ className: 'sl-change-head' },
			h('span', { className: 'sl-change-id' }, change.id),
			h(StatusPill, { t, status: change.status }),
			h(
				'span',
				{ className: 'sl-hint' },
				change.tasksTotal > 0
					? t('card.tasks', { done: change.tasksDone, total: change.tasksTotal })
					: t('card.noTasks'),
			),
			h('span', { className: 'sl-hint' }, t('card.iterations', { done: change.iterations, max: change.maxIterations })),
			active ? h('span', { className: 'sl-spinner' }) : null,
			h('span', { className: 'sl-hint sl-row-end' }, t('card.updatedAt', { time: formatRelative(change.updatedAt, t) })),
		),
		h(ProgressBar, {
			done: change.tasksDone,
			total: change.tasksTotal,
			label: t('card.tasks', { done: change.tasksDone, total: change.tasksTotal }),
		}),
		change.title || change.summary
			? h(
					'div',
					{ className: 'sl-change-title' },
					change.title ? h('div', null, change.title) : null,
					change.summary ? h('div', { className: 'sl-change-summary' }, clip(change.summary, 400)) : null,
				)
			: null,
		change.error ? h(Notice, { tone: 'error' }, change.error) : null,
		change.note ? h(Notice, { tone: change.status === 'done' ? 'ok' : 'warn' }, change.note) : null,
		h(
			'div',
			{ className: 'sl-change-actions' },
			active
				? h(
						'button',
						{ type: 'button', className: 'sl-btn', disabled: loop.busy, onClick: () => void loop.act((id) => api.stop(id, change.id), { note: `已停止 ${change.id}` }) },
						t('card.stop'),
					)
				: h(
						'button',
						{
							type: 'button',
							className: 'sl-btn sl-btn-primary',
							disabled: loop.busy,
							onClick: () => void loop.act((id) => api.run(id, change.id)),
						},
						done ? t('card.retry') : change.iterations > 0 ? t('card.continue') : t('card.start'),
					),
			active || parked
				? null
				: h(
						'label',
						{ className: 'sl-row', title: t('card.rounds') },
						h('span', { className: 'sl-hint' }, t('card.rounds')),
						h('input', {
							className: 'sl-input sl-input-num',
							type: 'number',
							min: 1,
							max: 50,
							value: roundsValue,
							onChange: (event) => setRoundsDraft(event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'Enter') saveRounds();
							},
						}),
						roundsDirty
							? h('button', { type: 'button', className: 'sl-btn', disabled: loop.busy, onClick: saveRounds }, t('card.roundsSave'))
							: null,
					),
			change.sessionId
				? h(
						'button',
						{
							type: 'button',
							className: 'sl-btn sl-btn-quiet sl-mono',
							// Say which of the two actions this click will take. A tooltip that
							// promises a jump and performs a copy is worse than no tooltip.
							title: canJump
								? `${t('card.openSession')}: ${change.sessionId}`
								: `${t('card.copySession')}: ${change.sessionId}`,
							onClick: revealSession,
						},
						copied ? '✓' : `${canJump ? '▶' : '◈'} ${shortSessionId(change.sessionId)}`,
					)
				: null,
			h(
				'button',
				{ type: 'button', className: 'sl-btn sl-btn-quiet sl-row-end', onClick: () => onToggle(change.id) },
				open ? t('card.hideDetails') : t('card.details'),
			),
		),
		open
			? h(
					'div',
					{ className: 'sl-details' },
					change.log && change.log.length > 0
						? h('div', { className: 'sl-log' }, ...[...change.log].reverse().map((entry, index) => h(LogEntry, { t, entry, key: `${entry.round}-${index}` })))
						: h('div', { className: 'sl-hint' }, t('card.logEmpty')),
					change.validation
						? h(
								'div',
								{ className: 'sl-settings-field' },
								h('span', { className: 'sl-label' }, t('card.validation')),
								h('pre', { className: 'sl-log-note sl-mono' }, clip(change.validation, 2000)),
							)
						: null,
					h(
						'div',
						{ className: 'sl-row' },
						confirming
							? h(
									'div',
									{ className: 'sl-row' },
									h('span', { className: 'sl-hint' }, t('card.deleteHint')),
									h(
										'button',
										{
											type: 'button',
											className: 'sl-btn',
											disabled: loop.busy,
											onClick: () => {
												setConfirming(false);
												void loop.act((id) => api.remove(id, change.id), { note: `已从列表移除 ${change.id}` });
											},
										},
										t('card.deleteConfirm'),
									),
									h('button', { type: 'button', className: 'sl-btn sl-btn-quiet', onClick: () => setConfirming(false) }, '×'),
								)
							: h(
									'button',
									{
										type: 'button',
										className: 'sl-btn sl-btn-quiet',
										disabled: active,
										onClick: () => setConfirming(true),
									},
									t('card.delete'),
								),
					),
				)
			: null,
	);
}

/**
 * The settings panel.
 * @param {object} props - `t`, `loop`, `settings`, and `onClose`.
 * @returns {object} the element.
 */
function SettingsPanel({ t, loop, settings, onClose }) {
	const [draft, setDraft] = React.useState(settings);
	React.useEffect(() => setDraft(settings), [settings]);
	if (draft === null || draft === undefined) return null;
	/** Patch one field of the draft. */
	const set = (patch) => setDraft({ ...draft, ...patch });
	/** One numeric field. */
	const number = (key, min, max) =>
		h('input', {
			className: 'sl-input sl-input-num',
			type: 'number',
			min,
			max,
			value: draft[key],
			onChange: (event) => set({ [key]: Number.parseInt(event.target.value, 10) }),
		});
	return h(
		'div',
		{ className: 'sl-card' },
		h(
			'div',
			{ className: 'sl-row' },
			h('span', { className: 'sl-title' }, t('settings.title')),
			h('button', { type: 'button', className: 'sl-btn sl-btn-quiet sl-row-end', onClick: onClose }, t('settings.close')),
		),
		h(
			'div',
			{ className: 'sl-settings-grid' },
			h('span', { className: 'sl-label' }, t('settings.defaultRounds')),
			h(
				'div',
				{ className: 'sl-settings-field' },
				number('ralphIterations', 1, 50),
				h('span', { className: 'sl-hint' }, t('settings.defaultRoundsHint')),
			),
			h('span', { className: 'sl-label' }, t('settings.concurrency')),
			h(
				'div',
				{ className: 'sl-settings-field' },
				number('concurrency', 1, 8),
				h('span', { className: 'sl-hint' }, t('settings.concurrencyHint')),
			),
			h('span', { className: 'sl-label' }, t('settings.timeout')),
			h(
				'div',
				{ className: 'sl-settings-field' },
				number('iterationTimeoutMinutes', 1, 1440),
				h('span', { className: 'sl-hint' }, t('settings.timeoutHint')),
			),
			h('span', { className: 'sl-label' }, t('settings.stall')),
			h(
				'div',
				{ className: 'sl-settings-field' },
				number('stallLimit', 1, 20),
				h('span', { className: 'sl-hint' }, t('settings.stallHint')),
			),
			h('span', { className: 'sl-label' }, t('settings.autoApprove')),
			h(
				'label',
				{ className: 'sl-checkbox' },
				h('input', {
					type: 'checkbox',
					checked: draft.autoApprove === true,
					onChange: (event) => set({ autoApprove: event.target.checked }),
				}),
				h('span', { className: 'sl-hint' }, t('settings.autoApproveHint')),
			),
			h('span', { className: 'sl-label' }, t('settings.command')),
			h(
				'div',
				{ className: 'sl-settings-field' },
				h('input', {
					className: 'sl-input sl-input-wide',
					type: 'text',
					value: draft.openspecCommand,
					onChange: (event) => set({ openspecCommand: event.target.value }),
				}),
				h('span', { className: 'sl-hint' }, t('settings.commandHint')),
			),
		),
		h(
			'div',
			{ className: 'sl-row' },
			h(
				'button',
				{
					type: 'button',
					className: 'sl-btn sl-btn-primary',
					disabled: loop.busy,
					onClick: () => void loop.act((id) => api.saveSettings(id, draft), { note: t('settings.saved') }),
				},
				t('settings.save'),
			),
		),
	);
}

/**
 * One proposed change, as the user reviews it.
 *
 * There is nothing here but the plan — an id, a title, a summary, and the user's
 * decision to include it. That is not a simplification for its own sake: the
 * documents do not exist yet. They are written after confirmation, by the agent
 * running the OpenSpec skill, so this card is the last chance to correct the
 * *split* — the one thing that is actually being agreed to here.
 *
 * The title and summary are editable because those are what the change list will
 * show and what the creating turn is told; the id is not, because it becomes a
 * directory name that the plugin verifies against, and an id edited here after
 * the agent proposed it would simply fail to appear.
 *
 * @param {object} props - `t`, `entry`, and the edit callbacks.
 * @returns {object} the element.
 */
function ProposalEntry({ t, entry, onToggle, onEdit }) {
	const included = entry.include !== false;
	const edit = (patch) => onEdit(entry.id, patch);

	return h(
		'div',
		{ className: `sl-proposal${included ? '' : ' sl-proposal-off'}` },
		h(
			'div',
			{ className: 'sl-proposal-head' },
			h('input', {
				type: 'checkbox',
				className: 'sl-check',
				checked: included,
				'aria-label': t('proposal.include'),
				onChange: (event) => onToggle(entry.id, event.target.checked),
			}),
			h('input', {
				className: 'sl-input sl-proposal-title',
				type: 'text',
				value: entry.title,
				disabled: !included,
				'aria-label': t('proposal.title'),
				onChange: (event) => edit({ title: event.target.value }),
			}),
			h('code', { className: 'sl-proposal-id' }, entry.id),
		),
		h('textarea', {
			className: 'sl-textarea sl-proposal-summary',
			value: entry.summary,
			disabled: !included,
			rows: 2,
			'aria-label': t('discuss.title'),
			onChange: (event) => edit({ summary: event.target.value }),
		}),

	);
}

/**
 * The pending plan: what will be created, once the user says so.
 *
 * @param {object} props - `t`, `sessionId`, `loop`, and the discussion.
 * @returns {object} the element.
 */
function ProposalPanel({ t, sessionId, loop, discussion }) {
	const proposal = discussion.proposal;
	const entries = proposal.entries ?? [];
	// The host always sends `dropped`, but a page that throws on a snapshot it did
	// not expect is a page with a blank tab instead of an explanation.
	const dropped = proposal.dropped ?? [];
	const selected = entries.filter((entry) => entry.include !== false);
	const [confirming, setConfirming] = React.useState(false);

	/** Fold one edited field back into the host's copy of the draft. */
	const onEdit = (id, patch) => {
		void loop.act((session) => api.updateDraft(session, { [id]: patch }));
	};
	const onToggle = (id, include) => onEdit(id, { include });

	const confirm = () => {
		setConfirming(true);
		void loop
			.act((session) => api.applyDraft(session), {
				// What there is to say depends on the answer: a clean creation and one
				// that came back with warnings are different outcomes to the user.
				note: (result) => {
					const warnings = result.warnings ?? [];
					return warnings.length > 0
						? t('proposal.createdWarnings', { list: warnings.join('；') })
						: t('proposal.created', { count: (result.ids ?? []).length });
				},
			})
			.finally(() => setConfirming(false));
	};

	return h(
		'div',
		{ className: 'sl-card' },
		h(
			'div',
			{ className: 'sl-row' },
			h('span', { className: 'sl-label' }, t('proposal.title')),
			h('span', { className: 'sl-hint' }, t('proposal.count', { total: entries.length, selected: selected.length })),
		),
		dropped.length > 0
			? h(
					'div',
					{ className: 'sl-log' },
					h('span', { className: 'sl-hint' }, t('proposal.dropped', { count: dropped.length })),
					...dropped.map((entry, index) =>
						h('div', { className: 'sl-log-note', key: index }, `· ${entry.id ?? '?'}：${entry.reason}`),
					),
				)
			: null,
		h(
			'div',
			{ className: 'sl-list' },
			...entries.map((entry) =>
				h(ProposalEntry, { key: entry.id, t, entry, onToggle, onEdit }),
			),
		),
		h('span', { className: 'sl-hint' }, t('proposal.confirmHint')),
		h(
			'div',
			{ className: 'sl-row' },
			h(
				'button',
				{ type: 'button', className: 'sl-btn sl-btn-primary', disabled: loop.busy || selected.length === 0, onClick: confirm },
				confirming ? t('proposal.confirming') : t('proposal.confirm', { count: selected.length }),
			),
			h(DiscardButton, { t, loop }),
		),
	);
}

/**
 * The discard button, with its one-step confirmation.
 * @param {object} props - `t` and `loop`.
 * @returns {object} the element.
 */
function DiscardButton({ t, loop }) {
	const [confirming, setConfirming] = React.useState(false);
	if (!confirming) {
		return h(
			'button',
			{
				type: 'button',
				className: 'sl-btn sl-btn-quiet sl-row-end',
				title: t('discuss.discardHint'),
				disabled: loop.busy,
				onClick: () => setConfirming(true),
			},
			t('discuss.discard'),
		);
	}
	return h(
		'span',
		{ className: 'sl-row sl-row-end' },
		h('span', { className: 'sl-hint' }, t('discuss.discardHint')),
		h(
			'button',
			{
				type: 'button',
				className: 'sl-btn',
				onClick: () => {
					setConfirming(false);
					void loop.act((session) => api.discardDraft(session), { note: t('discuss.discarded') });
				},
			},
			t('discuss.discardConfirm'),
		),
		h('button', { type: 'button', className: 'sl-btn sl-btn-quiet', onClick: () => setConfirming(false) }, '×'),
	);
}

/**
 * What the page shows when there is no discussion: how to start one.
 *
 * The command line is the only entry point — there is no textarea here on
 * purpose. A requirement typed into this panel would open a discussion the user
 * could not continue, because the conversation happens in the composer, and a
 * second, half-working way in is worse than none. So the panel states the
 * command, offers it on the clipboard, and gets out of the way.
 *
 * @param {object} props - `t`.
 * @returns {object} the element.
 */
function CommandHint({ t }) {
	const [copied, setCopied] = React.useState(false);
	const copy = () => {
		try {
			void navigator.clipboard?.writeText('/spec ');
			setCopied(true);
			setTimeout(() => setCopied(false), 1400);
		} catch {
			/* A clipboard that refuses simply does not confirm. */
		}
	};
	return h(
		'div',
		{ className: 'sl-card' },
		h('span', { className: 'sl-label' }, t('discuss.title')),
		h(
			'div',
			{ className: 'sl-row' },
			h(
				'p',
				{ className: 'sl-copy' },
				t('discuss.hintBefore'),
				h('code', { className: 'sl-code' }, '/spec'),
				t('discuss.hintAfter'),
			),
			h(
				'button',
				{ type: 'button', className: 'sl-btn sl-row-end', onClick: copy },
				copied ? t('discuss.copied') : t('discuss.copy'),
			),
		),
		h('span', { className: 'sl-hint' }, t('discuss.howItWorks')),
	);
}

/**
 * The discussion in progress: the requirement, and the plan when there is one.
 *
 * @param {object} props - `t`, `sessionId`, `loop`, and the discussion.
 * @returns {object} the element.
 */
function DiscussionPanel({ t, sessionId, loop, discussion }) {
	const proposed = discussion.status === 'proposed' && discussion.proposal !== null;
	const [asking, setAsking] = React.useState(false);

	const askForPlan = () => {
		setAsking(true);
		void loop
			.act((session) => api.planDraft(session), { note: t('discuss.planSent') })
			.finally(() => setAsking(false));
	};

	return h(
		'div',
		{ className: 'sl-card' },
		h(
			'div',
			{ className: 'sl-row' },
			h('span', { className: 'sl-label' }, t('discuss.title')),
			h(
				'span',
				{ className: `sl-pill sl-tone-${proposed ? 'ok' : 'busy'}` },
				proposed ? t('discuss.status.proposed') : t('discuss.status.discussing'),
			),
			!proposed ? h('span', { className: 'sl-spinner' }) : null,
			h(
				'button',
				{ type: 'button', className: 'sl-btn sl-btn-quiet sl-row-end', disabled: loop.busy || asking, onClick: askForPlan },
				asking ? t('proposal.confirming') : t('discuss.plan'),
			),
		),
		h('span', { className: 'sl-label' }, t('discuss.requirement')),
		h('div', { className: 'sl-change-summary' }, discussion.requirement),
		proposed ? null : h('span', { className: 'sl-hint' }, t('discuss.howItWorks')),
		proposed
			? h(ProposalPanel, { t, sessionId, loop, discussion })
			: h(
					'div',
					{ className: 'sl-row' },
					h(
						'span',
						{ className: 'sl-hint' },
						h('code', { className: 'sl-code' }, '/spec plan'),
						' · ',
						h('code', { className: 'sl-code' }, '/spec cancel'),
					),
					h(DiscardButton, { t, loop }),
				),
	);
}

/**
 * The page body, given a snapshot.
 *
 * Split out from the page because the polling lives in an effect, and effects do
 * not run in a server render: rendering `SpecLoopPage` directly can only ever
 * reach its loading state, which would leave the loaded page — the part with the
 * discussion, the plan and the change list — unrendered by every test. This takes
 * the snapshot as a prop instead, so a test can put the page in any state at all.
 *
 * @param {object} props - `t`, `sessionId`, `loop`, the current snapshot, and the
 *   session-navigation pair handed down to every card.
 * @returns {object} the element.
 */
function SpecLoopView({ t, sessionId, loop, state, openSession, canOpenSession }) {
	const [showSettings, setShowSettings] = React.useState(false);
	const [openIds, setOpenIds] = React.useState({});

	const openspec = state?.openspec ?? null;
	const changes = state?.changes ?? [];
	const discussion = state?.discussion ?? null;
	// A discussion counts as work in flight: the agent is thinking between turns,
	// and every control that starts or changes something has to stay off until it
	// settles, or a click would race the next turn.
	const working = changes.some((change) => change.active === true) || discussion !== null;

	/** Toggle one card's details. */
	const toggleDetails = (id) => setOpenIds((current) => ({ ...current, [id]: current[id] !== true }));

	if (state === null) {
		return h(
			'div',
			{ className: 'sl-root' },
			loop.loadError.length > 0
				? h(Notice, { tone: 'error' }, t('state.loadFailed', { message: loop.loadError }))
				: h(Notice, null, h('span', { className: 'sl-spinner' }), t('state.loading')),
		);
	}

	return h(
		'div',
		{ className: 'sl-root' },
		h(
			'div',
			{ className: 'sl-header' },
			h(
				'div',
				{ className: 'sl-titles' },
				h('span', { className: 'sl-title' }, t('page.title')),
				h('span', { className: 'sl-subtitle' }, t('page.subtitle')),
			),
			h(
				'div',
				{ className: 'sl-meta' },
				state.projectPath
					? h('span', { className: 'sl-mono sl-truncate', title: state.projectPath }, state.projectPath)
					: null,
				h(
					'button',
					{ type: 'button', className: 'sl-btn sl-btn-quiet', disabled: loop.busy, onClick: () => loop.reload() },
					t('list.refresh'),
				),
				h(
					'button',
					{ type: 'button', className: 'sl-btn sl-btn-quiet', onClick: () => setShowSettings((value) => !value) },
					t('list.settings'),
				),
			),
		),

		state.loadError ? h(Notice, { tone: 'warn' }, t('state.stale', { message: state.loadError })) : null,
		loop.loadError.length > 0 ? h(Notice, { tone: 'error' }, t('state.loadFailed', { message: loop.loadError })) : null,
		loop.actionError.length > 0 ? h(Notice, { tone: 'error' }, t('action.failed', { message: loop.actionError })) : null,
		loop.actionNote.length > 0 ? h(Notice, { tone: 'ok' }, loop.actionNote) : null,

		state.projectPath === null ? h(Notice, { tone: 'warn' }, t('state.noProject')) : null,

		openspec !== null && openspec.available !== true ? h(Notice, { tone: 'error' }, t('state.noOpenspec')) : null,

		openspec !== null && openspec.available === true && openspec.initialized !== true
			? h(
					Notice,
					{ tone: 'warn' },
					t('state.notInitialized'),
					h(
						'button',
						{
							type: 'button',
							className: 'sl-btn sl-btn-primary',
							disabled: loop.busy,
							onClick: () => void loop.act((id) => api.init(id)),
						},
						loop.busy ? t('init.running') : t('init.button'),
					),
				)
			: null,

		showSettings
			? h(SettingsPanel, { t, loop, settings: state.settings, onClose: () => setShowSettings(false) })
			: discussion === null
				? h(CommandHint, { t })
				: h(DiscussionPanel, { t, sessionId, loop, discussion }),

		h(
			'div',
			{ className: 'sl-row' },
			h('span', { className: 'sl-label' }, t('list.title')),
			h('span', { className: 'sl-hint' }, t('list.count', { count: changes.length })),
			h(
				'button',
				{
					type: 'button',
					className: 'sl-btn sl-row-end',
					disabled: loop.busy || changes.length === 0,
					title: t('list.importedNote'),
					onClick: () => void loop.act((id) => api.runAll(id)),
				},
				t('list.runAll'),
			),
		),

		changes.length === 0
			? h('div', { className: 'sl-empty' }, t('list.empty'))
			: h(
					'div',
					{ className: 'sl-list' },
					...changes.map((change) =>
						h(ChangeCard, {
							key: change.id,
							t,
							sessionId,
							change,
							loop,
							open: openIds[change.id] === true,
							onToggle: toggleDetails,
							openSession,
							canOpenSession,
						}),
					),
				),

		working ? h('div', { className: 'sl-row' }, h('span', { className: 'sl-spinner' })) : null,
	);
}

/**
 * The page, with its polling.
 * @param {object} props - `t` from the locale namespace, `sessionId` from the slot.
 * @returns {object} the element.
 */
function SpecLoopPage({ t, sessionId, openSession, canOpenSession }) {
	const loop = useLoopState(sessionId);
	return h(SpecLoopView, { t, sessionId, loop, state: loop.state, openSession, canOpenSession });
}
