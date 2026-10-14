/**
 * Host half of the spec-loop plugin: wiring, config, and lifecycle.
 *
 * The plugin owns one durable list and one runner. The browser half only
 * describes what should happen — split this requirement, run this change — and
 * every guarantee lives here, because this is the half that keeps working when
 * the page is closed: rounds still settle, the list still gets written, and a
 * restart still finds the work where it was left.
 *
 * Composition: the plugin needs the Host Web Session controller (to create a
 * session and admit a prompt), the session store (to turn a session into a
 * project directory), and the web server (to serve the panel). The live-agent
 * registry and the approval service are picked up opportunistically, so a leaner
 * composition degrades instead of refusing to load.
 *
 * @module dsh-plugin-spec-loop
 */

import { createSpecCommand } from './command.js';
import { createHandler, ROUTE_PREFIX } from './http.js';
import { Openspec } from './openspec.js';
import { Privileges } from './privilege.js';
import { Proposals } from './proposal.js';
import { RalphRunner } from './ralph.js';
import { SessionSeam } from './session.js';
import { SpecLoopStore, defaultFilePath, normalizeSettings } from './state.js';
import { createProposeTool } from './tool.js';

/** The Cordis plugin name, which also names the loader row. */
export const name = 'dsh-plugin-spec-loop';

/**
 * Services activation waits for.
 *
 * `sessionController` is a hard requirement: without it there is nothing to
 * drive a round with. `sessions` is how a request's session becomes a project
 * directory, which is what makes "the change belongs to this repository" true.
 * `webServer` is what the page reaches. `agents` is the live-agent registry the
 * loop falls back to when the controller hands back no agent.
 *
 * Every one of these must be declared, not merely reached for: Cordis throws on
 * a property read for an undeclared service, so an undeclared access inside a
 * try/catch is a bug that hides behind its own fallback.
 */
export const inject = ['sessionController', 'webServer', 'sessions', 'agents'];

/**
 * Optional services the plugin uses when the composition provides them.
 *
 * `commands` and `tools` are the surfaces the discussion runs on: without them
 * the panel and the loop still work, so they are not injected as hard
 * requirements. A leaner composition loses the `/spec` entry point rather than
 * refusing to load at all.
 */
const OPTIONAL_SERVICES = ['approval', 'commands', 'tools'];

/**
 * The plugin's composition config, validated through Cordis' standard-schema seam.
 *
 * These values are a *seed*: they are written into the durable document the first
 * time it is created, and after that the document — which the page edits — is the
 * truth. A composition config that reasserted itself on every restart would undo
 * the settings the user just chose.
 *
 * `file` rides alongside the settings rather than inside them because it chooses
 * where the durable document lives; it is not a preference the page edits.
 */
export const Config = {
	'~standard': {
		version: 1,
		vendor: 'dsh-plugin-spec-loop',
		/**
		 * @param {unknown} value - the raw composition config.
		 * @returns {{ value: object }} the normalized plugin settings.
		 */
		validate(value) {
			const raw = value !== null && typeof value === 'object' ? value : {};
			return {
				value: {
					...normalizeSettings(raw),
					file: typeof raw.file === 'string' ? raw.file.trim() : '',
				},
			};
		},
	},
};

/**
 * Start the plugin.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {object} config - the validated composition config.
 * @returns {void}
 */
export function apply(ctx, config) {
	/** Route diagnostics into the Host log, where a failed proposal is visible. */
	const log = (message) => {
		try {
			ctx.logger?.info?.(`spec-loop: ${message}`);
		} catch {
			/* A logger that will not accept the message must not break the plugin. */
		}
	};

	const configuredFile = typeof config?.file === 'string' ? config.file.trim() : '';
	const store = new SpecLoopStore({
		file: configuredFile.length > 0 ? configuredFile : defaultFilePath(),
		seedSettings: config ?? {},
		onError: (error) => log(`state error: ${String(error)}`),
	});
	store.load();

	// Cordis throws on a property read for a service the plugin did not declare,
	// so an optional dependency is picked up through `ctx.inject`: the handle
	// appears when the service mounts and is withdrawn if it unmounts, and its
	// absence is never an exception. Reaching for `ctx.approval` directly and
	// catching the throw would look like it worked while silently disabling the
	// richer path forever.
	const optionalServices = {};
	for (const key of OPTIONAL_SERVICES) {
		ctx.inject([key], (scoped) => {
			optionalServices[key] = scoped[key];
			return () => {
				optionalServices[key] = undefined;
			};
		});
	}

	/** The CLI command to use, from the durable settings. */
	const commandFor = () => store.settings().openspecCommand;

	/**
	 * The project directory a session belongs to.
	 *
	 * The session's own recorded working directory, not a workspace lookup: OpenSpec
	 * resolves from the directory the work happens in, and the session header is the
	 * authoritative record of that. A session with no directory has no project, and
	 * the page says so instead of aiming the loop at the process default.
	 *
	 * @param {string} sessionId - the session named by a request.
	 * @returns {string | undefined} its working directory.
	 */
	const projectOfSession = (sessionId) => {
		let cwd = '';
		try {
			cwd = ctx.sessions.get(sessionId)?.header?.cwd ?? '';
		} catch {
			// A session that is not live cannot name a directory.
			return undefined;
		}
		return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
	};

	const privileges = new Privileges(ctx, { services: optionalServices, log });
	const sessions = new SessionSeam({ ctx, privileges, log });
	const proposals = new Proposals({ store, commandFor, log });
	const runner = new RalphRunner({
		ctx,
		store,
		sessions,
		commandFor,
		autoApprove: () => store.settings().autoApprove,
		log,
	});
	const handler = createHandler({ store, proposals, sessions, runner, projectOfSession, commandFor, log });

	/**
	 * Register on an optional service, tolerating a composition without it.
	 *
	 * A duplicate name throws — the composition may already have something called
	 * `spec` — and that must cost the plugin its command, not its ability to load.
	 *
	 * @param {string} service - the service key.
	 * @param {(registry: object) => unknown} register - the registration.
	 * @param {string} label - what is being registered, for the log.
	 * @returns {void}
	 */
	const registerOn = (service, register, label) => {
		ctx.inject([service], (scoped) => {
			try {
				const disposer = register(scoped[service]);
				return typeof disposer === 'function' ? disposer : undefined;
			} catch (error) {
				log(`could not register ${label} on ${service}: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			}
		});
	};

	registerOn(
		'commands',
		(commands) =>
			commands.register(
				createSpecCommand({ store, proposals, sessions, projectOfSession, commandFor, log }),
			),
		'the /spec command',
	);
	registerOn(
		'tools',
		(tools) => tools.register(createProposeTool({ store, projectOfSession, log })),
		'spec_loop_propose',
	);

	// Registration order is teardown order reversed, and the reverse order is the
	// one that matters: routes stop accepting new work, then the loop stops
	// claiming, then the in-flight waiters are failed, then the permission hooks
	// come down. Nothing can be dispatched into a half-torn-down plugin.
	ctx.effect(() => privileges.install(), 'spec-loop: unattended-execution hooks');
	ctx.effect(() => sessions.install(), 'spec-loop: turn watchers');
	ctx.effect(() => () => runner.dispose(), 'spec-loop: ralph runners');
	ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), 'spec-loop: control routes');

	// The list is durable and the repository is not, so the two drift as soon as a
	// change is created by hand or pulled from a branch. Reconciling at startup
	// means the page describes the project rather than the last time it was used.
	ctx.effect(() => {
		let cancelled = false;
		void (async () => {
			for (const projectPath of Object.keys(store.document.projects)) {
				if (cancelled) return;
				try {
					await handler.reconcile(projectPath);
				} catch (error) {
					log(`could not reconcile ${projectPath}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, 'spec-loop: startup reconciliation');

	const probe = new Openspec({ projectPath: process.cwd(), command: commandFor(), log }).describe();
	log(
		`ready: ${Object.keys(store.document.projects).length} project(s) tracked, ` +
			`openspec ${probe.available ? `found at ${probe.executable}` : 'NOT found on PATH'}`,
	);
}
