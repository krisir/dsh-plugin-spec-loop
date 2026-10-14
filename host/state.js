/**
 * The durable document: the change list the page shows and the settings it edits.
 *
 * The store is deliberately dumb. It holds one JSON document, hands out
 * mutations, and writes atomically; every rule about what a change *means* lives
 * in the loop and the OpenSpec seam. That split matters because the document is
 * what survives a restart, and a document that also encoded behaviour would have
 * to be migrated every time the behaviour changed.
 *
 * Writes are write-temp-then-rename, so a crash mid-write leaves the previous
 * document intact rather than a truncated one. A document that fails to parse on
 * load is set aside rather than thrown away, because the alternative — starting
 * from an empty list — silently loses the user's work at exactly the moment they
 * most want to know what happened.
 *
 * @module dsh-plugin-spec-loop/state
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The document format this build writes and understands. */
export const DOCUMENT_VERSION = 1;

/**
 * Every status a change can hold.
 *
 * `draft` is a change that exists in the repository but has never been run;
 * `queued` is one waiting for a slot; `running` is one the loop owns right now.
 * The terminal states are kept apart on purpose, because they call for different
 * responses from the user: `done` needs nothing, `exhausted` needs more rounds,
 * `blocked` needs the change looked at, and `failed` needs the error read.
 */
export const CHANGE_STATUS = {
	draft: 'draft',
	queued: 'queued',
	running: 'running',
	done: 'done',
	exhausted: 'exhausted',
	blocked: 'blocked',
	failed: 'failed',
	cancelled: 'cancelled',
};

/** Statuses that mean the change is not being worked on and can be started. */
export const IDLE_STATUSES = new Set([
	CHANGE_STATUS.draft,
	CHANGE_STATUS.done,
	CHANGE_STATUS.exhausted,
	CHANGE_STATUS.blocked,
	CHANGE_STATUS.failed,
	CHANGE_STATUS.cancelled,
]);

/** Statuses that mean the loop is actively working on the change. */
export const ACTIVE_STATUSES = new Set([CHANGE_STATUS.queued, CHANGE_STATUS.running]);

/**
 * Where one session's requirement discussion stands.
 *
 * `discussing` means the user has stated a requirement and is talking it through
 * with the agent; nothing exists in the repository yet. `proposed` means the
 * agent has handed over a concrete plan that is waiting for the user to confirm
 * it. There is deliberately no `creating` state: creating is a single awaited
 * call, and a durable intermediate would only ever be observed after a crash.
 */
export const DRAFT_STATUS = {
	discussing: 'discussing',
	proposed: 'proposed',
};

/**
 * How many drafts the document keeps.
 *
 * A draft is per session and sessions are cheap, so without a cap the document
 * would grow forever with abandoned requirements. The list is trimmed oldest
 * first on write, which is safe because a draft nobody has touched in a hundred
 * sessions is not one anybody is about to confirm.
 */
const MAX_DRAFTS = 100;

/** The settings defaults, which are also the shape the seed is normalized into. */
export const DEFAULT_SETTINGS = {
	/** How many ralph rounds a newly created change gets by default. */
	ralphIterations: 3,
	/** How many changes may iterate at the same time. */
	concurrency: 1,
	/** How long one round may run before the turn is cancelled. */
	iterationTimeoutMinutes: 45,
	/** Consecutive rounds without task progress before a change is marked blocked. */
	stallLimit: 2,
	/** Whether plugin-driven sessions run with authorizations skipped. */
	autoApprove: true,
	/** The CLI to invoke; a bare name is searched on an augmented PATH. */
	openspecCommand: 'openspec',
};

/** Hard bounds, so a stray value in a hand-edited document cannot wedge the loop. */
const BOUNDS = {
	ralphIterations: [1, 50],
	concurrency: [1, 8],
	iterationTimeoutMinutes: [1, 24 * 60],
	stallLimit: [1, 20],
};

/**
 * Where the document lives when the configuration names no file.
 * @returns {string} the absolute path.
 */
export function defaultFilePath() {
	const home = process.env.DSH_HOME || join(homedir(), '.dsh');
	return join(home, 'spec-loop', 'state.json');
}

/** Clamp an integer into its documented range. */
function clampInt(value, fallback, [min, max]) {
	const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * Normalize a raw settings object into the complete, bounded settings shape.
 *
 * Accepts anything, because its two callers are a composition seed written by
 * hand and a request body from the page, and neither is trustworthy.
 *
 * @param {unknown} raw - the candidate settings.
 * @param {object} [base] - the settings to inherit missing fields from.
 * @returns {object} a complete settings object.
 */
export function normalizeSettings(raw, base = DEFAULT_SETTINGS) {
	const source = raw !== null && typeof raw === 'object' ? raw : {};
	const seed = base ?? DEFAULT_SETTINGS;
	const command = typeof source.openspecCommand === 'string' ? source.openspecCommand.trim() : '';
	return {
		ralphIterations: clampInt(source.ralphIterations, seed.ralphIterations, BOUNDS.ralphIterations),
		concurrency: clampInt(source.concurrency, seed.concurrency, BOUNDS.concurrency),
		iterationTimeoutMinutes: clampInt(
			source.iterationTimeoutMinutes,
			seed.iterationTimeoutMinutes,
			BOUNDS.iterationTimeoutMinutes,
		),
		stallLimit: clampInt(source.stallLimit, seed.stallLimit, BOUNDS.stallLimit),
		autoApprove: typeof source.autoApprove === 'boolean' ? source.autoApprove : seed.autoApprove,
		openspecCommand: command.length > 0 ? command : seed.openspecCommand,
	};
}

/** An empty document. */
function emptyDocument(seedSettings) {
	return { version: DOCUMENT_VERSION, settings: normalizeSettings(seedSettings), projects: {}, drafts: {} };
}

/** A fresh record for one change. */
export function newChangeRecord(id, options = {}) {
	const now = Date.now();
	return {
		id,
		title: typeof options.title === 'string' ? options.title : '',
		summary: typeof options.summary === 'string' ? options.summary : '',
		status: CHANGE_STATUS.draft,
		iterations: 0,
		maxIterations: options.maxIterations,
		tasksTotal: 0,
		tasksDone: 0,
		sessionId: '',
		plannerSessionId: typeof options.plannerSessionId === 'string' ? options.plannerSessionId : '',
		createdAt: now,
		updatedAt: now,
		startedAt: 0,
		finishedAt: 0,
		error: '',
		note: '',
		validation: '',
		log: [],
	};
}

/**
 * A fresh draft for one session's requirement discussion.
 *
 * @param {string} sessionId - the session the discussion happens in.
 * @param {object} [options] - seed values.
 * @returns {object} the draft.
 */
export function newDraft(sessionId, options = {}) {
	const now = Date.now();
	return {
		sessionId,
		projectPath: typeof options.projectPath === 'string' ? options.projectPath : '',
		requirement: typeof options.requirement === 'string' ? options.requirement : '',
		status: DRAFT_STATUS.discussing,
		createdAt: now,
		updatedAt: now,
		/** The agent's plan, present only while `status` is `proposed`. */
		proposal: undefined,
		/** Why entries were refused, so the page can explain a short plan. */
		dropped: [],
	};
}

/**
 * Normalize one agent-proposed change into the shape the page and the creator use.
 *
 * A plan entry is three fields, because that is all the agent submits: the
 * artifacts it will later write are the `openspec-propose` skill's output, not
 * something the plugin collects up front and replays.
 *
 * `include` is the user's selection and is the only field here the agent does not
 * control: rejecting a change is the user's prerogative, and defaulting to
 * included means the common case — a plan the user is happy with — is one click.
 *
 * @param {object} source - a normalized entry from the proposal reader.
 * @returns {object} the stored entry.
 */
export function newProposalEntry(source) {
	return {
		id: source.id,
		title: source.title,
		summary: source.summary,
		include: true,
	};
}

/**
 * Normalize a draft read from disk, or return undefined when it is unusable.
 *
 * @param {unknown} raw - the stored draft.
 * @param {string} sessionId - the key it was stored under.
 * @returns {object | undefined} the draft.
 */
function normalizeDraft(raw, sessionId) {
	if (raw === null || typeof raw !== 'object') return undefined;
	const draft = newDraft(sessionId, {
		projectPath: raw.projectPath,
		requirement: raw.requirement,
	});
	draft.status = Object.values(DRAFT_STATUS).includes(raw.status) ? raw.status : DRAFT_STATUS.discussing;
	draft.createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : draft.createdAt;
	draft.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : draft.updatedAt;
	draft.dropped = Array.isArray(raw.dropped) ? raw.dropped.filter((entry) => entry !== null && typeof entry === 'object').slice(0, 50) : [];
	const entries = Array.isArray(raw.proposal?.entries) ? raw.proposal.entries : [];
	const kept = entries
		.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
		.map((entry) => ({
			...newProposalEntry({
				id: entry.id,
				title: typeof entry.title === 'string' ? entry.title : entry.id,
				summary: typeof entry.summary === 'string' ? entry.summary : '',
			}),
			include: entry.include !== false,
		}));
	// A `proposed` draft with nothing in it would show the user a confirm button
	// that creates nothing, so it is read back as still-discussing instead.
	if (draft.status === DRAFT_STATUS.proposed && kept.length > 0) {
		draft.proposal = { entries: kept, at: Number.isFinite(raw.proposal?.at) ? raw.proposal.at : draft.updatedAt };
	}
	return draft;
}

/** Bring a record read from disk up to the current shape. */
function normalizeRecord(raw, id, fallbackIterations) {
	const source = raw !== null && typeof raw === 'object' ? raw : {};
	const record = newChangeRecord(id, {
		title: source.title,
		summary: source.summary,
		maxIterations: clampInt(source.maxIterations, fallbackIterations, BOUNDS.ralphIterations),
		plannerSessionId: source.plannerSessionId,
	});
	record.status = Object.values(CHANGE_STATUS).includes(source.status) ? source.status : CHANGE_STATUS.draft;
	record.iterations = clampInt(source.iterations, 0, [0, 10_000]);
	record.tasksTotal = clampInt(source.tasksTotal, 0, [0, 100_000]);
	record.tasksDone = clampInt(source.tasksDone, 0, [0, 100_000]);
	record.sessionId = typeof source.sessionId === 'string' ? source.sessionId : '';
	record.createdAt = Number.isFinite(source.createdAt) ? source.createdAt : record.createdAt;
	record.updatedAt = Number.isFinite(source.updatedAt) ? source.updatedAt : record.updatedAt;
	record.startedAt = Number.isFinite(source.startedAt) ? source.startedAt : 0;
	record.finishedAt = Number.isFinite(source.finishedAt) ? source.finishedAt : 0;
	record.error = typeof source.error === 'string' ? source.error : '';
	record.note = typeof source.note === 'string' ? source.note : '';
	record.validation = typeof source.validation === 'string' ? source.validation : '';
	record.log = Array.isArray(source.log) ? source.log.filter((entry) => entry !== null && typeof entry === 'object').slice(-50) : [];
	return record;
}

/**
 * The durable change list.
 */
export class SpecLoopStore {
	/** @type {object} the in-memory document. */
	document = emptyDocument();

	/** @type {string | undefined} the last read or parse failure, for the page. */
	loadError;

	/**
	 * @param {object} options - construction options.
	 * @param {string} options.file - the document path.
	 * @param {object} [options.seedSettings] - composition config used to seed a new document.
	 * @param {(message: string) => void} [options.onError] - diagnostic sink.
	 */
	constructor({ file, seedSettings = {}, onError = () => {} }) {
		this.file = file;
		this.seedSettings = seedSettings;
		this.onError = onError;
	}

	/** Read the document from disk, tolerating everything that can go wrong. */
	load() {
		if (!existsSync(this.file)) {
			this.document = emptyDocument(this.seedSettings);
			return;
		}
		let text = '';
		try {
			text = readFileSync(this.file, 'utf8');
		} catch (error) {
			this.loadError = `无法读取 ${this.file}：${String(error)}`;
			this.onError(this.loadError);
			this.document = emptyDocument(this.seedSettings);
			return;
		}
		const recovered = this.#parse(text);
		if (recovered !== undefined) {
			this.document = recovered;
			return;
		}
		// The document exists but could not be understood. Move it aside so the
		// next write does not overwrite it: whatever is in there is the user's.
		const salvaged = `${this.file}.corrupt-${Date.now()}`;
		try {
			renameSync(this.file, salvaged);
			this.loadError = `状态文件无法解析，已备份到 ${salvaged}，并从空列表开始。`;
		} catch (error) {
			this.loadError = `状态文件无法解析且无法备份：${String(error)}`;
		}
		this.onError(this.loadError);
		this.document = emptyDocument(this.seedSettings);
	}

	/**
	 * Parse a document, returning undefined when it is not usable.
	 * @param {string} text - the raw file contents.
	 * @returns {object | undefined} the normalized document.
	 */
	#parse(text) {
		let raw;
		try {
			raw = JSON.parse(text);
		} catch {
			return undefined;
		}
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
		const settings = normalizeSettings(raw.settings, normalizeSettings(this.seedSettings));
		const document = { version: DOCUMENT_VERSION, settings, projects: {}, drafts: {} };
		const projects = raw.projects !== null && typeof raw.projects === 'object' ? raw.projects : {};
		for (const [path, project] of Object.entries(projects)) {
			if (project === null || typeof project !== 'object') continue;
			const changes = Array.isArray(project.changes) ? project.changes : [];
			document.projects[path] = {
				projectPath: path,
				changes: changes
					.filter((change) => change !== null && typeof change === 'object' && typeof change.id === 'string')
					.map((change) => normalizeRecord(change, change.id, settings.ralphIterations)),
			};
		}
		const drafts = raw.drafts !== null && typeof raw.drafts === 'object' ? raw.drafts : {};
		for (const [sessionId, draft] of Object.entries(drafts)) {
			const normalized = normalizeDraft(draft, sessionId);
			if (normalized !== undefined) document.drafts[sessionId] = normalized;
		}
		return document;
	}

	/** The current settings. */
	settings() {
		return this.document.settings;
	}

	/**
	 * Replace the settings.
	 * @param {unknown} patch - the candidate settings.
	 * @returns {object} the accepted settings.
	 */
	updateSettings(patch) {
		const merged = normalizeSettings({ ...this.document.settings, ...(patch ?? {}) }, this.document.settings);
		this.document.settings = merged;
		this.save();
		return merged;
	}

	/**
	 * The project bucket for a path, creating it when asked.
	 * @param {string} projectPath - the project directory.
	 * @param {boolean} [create] - whether to create a missing bucket.
	 * @returns {object | undefined} the bucket.
	 */
	project(projectPath, create = false) {
		const existing = this.document.projects[projectPath];
		if (existing !== undefined) return existing;
		if (!create) return undefined;
		const bucket = { projectPath, changes: [] };
		this.document.projects[projectPath] = bucket;
		return bucket;
	}

	/**
	 * The change records of one project.
	 * @param {string} projectPath - the project directory.
	 * @returns {object[]} the records.
	 */
	changes(projectPath) {
		return this.project(projectPath)?.changes ?? [];
	}

	/**
	 * Find one change.
	 * @param {string} projectPath - the project directory.
	 * @param {string} id - the change id.
	 * @returns {object | undefined} the record.
	 */
	find(projectPath, id) {
		return this.changes(projectPath).find((change) => change.id === id);
	}

	/**
	 * Find one change and create it when missing.
	 * @param {string} projectPath - the project directory.
	 * @param {string} id - the change id.
	 * @param {object} [options] - creation options.
	 * @returns {object} the record.
	 */
	ensure(projectPath, id, options = {}) {
		const bucket = this.project(projectPath, true);
		const existing = bucket.changes.find((change) => change.id === id);
		if (existing !== undefined) return existing;
		const record = newChangeRecord(id, {
			...options,
			maxIterations: options.maxIterations ?? this.document.settings.ralphIterations,
		});
		bucket.changes.push(record);
		return record;
	}

	/**
	 * The draft belonging to one session.
	 * @param {string} sessionId - the session.
	 * @returns {object | undefined} the draft.
	 */
	draft(sessionId) {
		if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
		return this.document.drafts[sessionId];
	}

	/**
	 * Replace a session's draft and persist it.
	 *
	 * Old drafts are trimmed here rather than on a timer: the write is already
	 * happening, and a document that only ever grows is the failure mode worth
	 * avoiding.
	 *
	 * @param {object} draft - the draft to store; its `sessionId` is the key.
	 * @returns {object} the stored draft.
	 */
	saveDraft(draft) {
		draft.updatedAt = Date.now();
		this.document.drafts[draft.sessionId] = draft;
		const keys = Object.keys(this.document.drafts);
		if (keys.length > MAX_DRAFTS) {
			const byAge = keys
				.map((key) => [key, this.document.drafts[key].updatedAt])
				.sort((left, right) => left[1] - right[1]);
			for (const [key] of byAge.slice(0, keys.length - MAX_DRAFTS)) {
				delete this.document.drafts[key];
			}
		}
		this.save();
		return draft;
	}

	/**
	 * Forget a session's draft.
	 * @param {string} sessionId - the session.
	 * @returns {boolean} whether there was one.
	 */
	clearDraft(sessionId) {
		if (this.document.drafts[sessionId] === undefined) return false;
		delete this.document.drafts[sessionId];
		this.save();
		return true;
	}

	/**
	 * Mutate the document and persist it.
	 *
	 * Every mutation goes through here so no caller can forget the write, and so
	 * the `updatedAt` stamp is applied in one place.
	 *
	 * @param {(document: object) => void} mutate - the change to apply.
	 * @returns {void}
	 */
	mutate(mutate) {
		mutate(this.document);
		this.save();
	}

	/** Write the document atomically. */
	save() {
		const directory = dirname(this.file);
		try {
			mkdirSync(directory, { recursive: true });
			const temporary = `${this.file}.${process.pid}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(this.document, null, '\t')}\n`, 'utf8');
			renameSync(temporary, this.file);
		} catch (error) {
			this.onError(`无法写入 ${this.file}：${String(error)}`);
			try {
				unlinkSync(`${this.file}.${process.pid}.tmp`);
			} catch {
				/* Nothing left to clean up. */
			}
		}
	}
}
