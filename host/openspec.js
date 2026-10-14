/**
 * The OpenSpec seam: everything this plugin knows about the `openspec` CLI.
 *
 * The plugin never parses or rewrites an OpenSpec artifact by hand. Every fact
 * it shows — how many tasks a change has, how many are done, which artifact
 * comes next, what the apply instruction is — is read from the CLI's own
 * `--json` output, and every write goes through the CLI too. That keeps the
 * plugin correct across OpenSpec versions whose file layout or schema changes:
 * when the CLI changes, the contract this file speaks is the part that changes,
 * not the page or the loop.
 *
 * Two environment details are handled here rather than left to chance:
 *
 * - **Finding the binary.** The Host is often launched from a GUI, so its
 *   `PATH` is the launchd one and does not contain `/opt/homebrew/bin`. A bare
 *   `openspec` therefore resolves from an augmented search path, and a
 *   configured absolute path always wins.
 * - **Never trusting exit codes alone.** Every failure carries the command, the
 *   exit code, and the captured stderr, because "openspec failed" is not
 *   something a user can act on.
 *
 * @module dsh-plugin-spec-loop/openspec
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

/** Directories a GUI-launched Host almost always omits from `PATH`. */
const PATH_FALLBACKS = [
	'/opt/homebrew/bin',
	'/opt/homebrew/sbin',
	'/usr/local/bin',
	'/usr/bin',
	'/bin',
	join(homedir(), '.local/bin'),
	join(homedir(), '.bun/bin'),
	join(homedir(), '.npm-global/bin'),
	join(homedir(), 'Library/pnpm'),
];

/** How long one CLI call may take before it is killed, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** The largest stdout/stderr captured from one CLI call. */
const MAX_BUFFER = 8 * 1024 * 1024;

/** The directory `openspec init` creates at the root of a project. */
export const OPENSPEC_DIR = 'openspec';

/** The file whose presence proves a directory really is an OpenSpec root. */
const CONFIG_FILE = 'config.yaml';

/** A CLI call that failed, carrying what the user needs to understand why. */
export class OpenspecError extends Error {
	/**
	 * @param {string} message - a human-readable summary.
	 * @param {object} [detail] - the captured command context.
	 * @param {string} [detail.command] - the resolved executable.
	 * @param {string[]} [detail.args] - the arguments it was given.
	 * @param {number | null} [detail.code] - the exit code, null when it never started.
	 * @param {string} [detail.stderr] - captured stderr.
	 */
	constructor(message, detail = {}) {
		super(message);
		this.name = 'OpenspecError';
		this.detail = detail;
	}
}

/**
 * Whether a path is an executable file.
 * @param {string} path - the candidate.
 * @returns {boolean} true when it can be spawned directly.
 */
function isExecutable(path) {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve the CLI to an absolute path.
 *
 * A configured value containing a separator is used as-is when it is
 * executable, so pinning a specific interpreter or wrapper works. A bare name
 * is searched in `PATH` first and then in the well-known locations a GUI launch
 * leaves out.
 *
 * @param {string} command - the configured command or an absolute path.
 * @returns {string | undefined} the absolute executable, or undefined.
 */
export function resolveExecutable(command) {
	const raw = typeof command === 'string' && command.trim().length > 0 ? command.trim() : 'openspec';
	if (raw.includes('/')) {
		const absolute = isAbsolute(raw) ? raw : resolve(raw);
		return isExecutable(absolute) ? absolute : undefined;
	}
	const search = [
		...(process.env.PATH ?? '').split(delimiter).filter((part) => part.length > 0),
		...PATH_FALLBACKS,
	];
	const seen = new Set();
	for (const dir of search) {
		if (seen.has(dir)) continue;
		seen.add(dir);
		const candidate = join(dir, raw);
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Walk up from a directory looking for an OpenSpec root.
 *
 * `nearest` is OpenSpec's own resolution rule, so this matches what the CLI
 * would do when run in the same directory — including the case where a change
 * is being planned in a subdirectory of the repository.
 *
 * @param {string} startDir - where to begin, normally a session's cwd.
 * @returns {string | undefined} the project root, or undefined.
 */
export function findOpenspecRoot(startDir) {
	if (typeof startDir !== 'string' || startDir.length === 0) return undefined;
	let current = resolve(startDir);
	for (;;) {
		const marker = join(current, OPENSPEC_DIR);
		if (existsSync(join(marker, CONFIG_FILE)) || existsSync(join(marker, 'changes'))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * Read a change's `tasks.md` directly.
 *
 * The CLI's own progress numbers are authoritative for the page, but the loop
 * needs the individual pending task lines to put in a prompt. Reading the file
 * is the only way to get them, and it is read-only: the CLI stays the writer.
 *
 * @param {string} changeDir - the change's directory.
 * @returns {{ total: number, done: number, pending: string[], items: object[] }} the tally.
 */
export function readTasks(changeDir) {
	let text = '';
	try {
		text = readFileSync(join(changeDir, 'tasks.md'), 'utf8');
	} catch {
		return { total: 0, done: 0, pending: [], items: [] };
	}
	return parseTaskText(text);
}

/**
 * Count and collect the checkbox tasks in `tasks.md` text.
 *
 * Split out from the file read because a proposal's task list has not been
 * written to a file yet, and it is parsed by exactly the same rules: the loop
 * counts these lines, so everything that counts them has to agree on what one is.
 *
 * @param {unknown} text - the markdown.
 * @returns {{ total: number, done: number, pending: string[], items: object[] }} the tally.
 */
export function parseTaskText(text) {
	const pending = [];
	const items = [];
	let total = 0;
	let done = 0;
	for (const line of String(text ?? '').split('\n')) {
		const match = /^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/.exec(line);
		if (match === null) continue;
		total += 1;
		const label = match[2];
		const numbered = /^(\d+(?:\.\d+)*)[.)]?\s+(.+)$/.exec(label);
		items.push({
			id: numbered === null ? String(total) : numbered[1],
			description: numbered === null ? label : numbered[2],
		});
		if (match[1].toLowerCase() === 'x') done += 1;
		else pending.push(label);
	}
	return { total, done, pending, items };
}

/**
 * A bound `openspec` CLI for one project directory.
 *
 * One instance per call site rather than a shared singleton: the project
 * directory is what makes a CLI invocation mean anything, and a shared instance
 * would be the natural place for one workspace's command to leak into another's.
 */
export class Openspec {
	/**
	 * @param {object} options - construction options.
	 * @param {string} options.projectPath - the project directory to run in.
	 * @param {string} [options.command] - the configured command.
	 * @param {(message: string) => void} [options.log] - diagnostic sink.
	 * @param {number} [options.timeoutMs] - per-call timeout.
	 */
	constructor({ projectPath, command = 'openspec', log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
		this.projectPath = resolve(projectPath);
		this.command = command;
		this.log = log;
		this.timeoutMs = timeoutMs;
		this.executable = resolveExecutable(command);
	}

	/** Whether the CLI was found at all. */
	get available() {
		return this.executable !== undefined;
	}

	/** The OpenSpec root for this project, or undefined when there is none yet. */
	get root() {
		return findOpenspecRoot(this.projectPath);
	}

	/** The `openspec/changes` directory, whether or not it exists yet. */
	get changesDir() {
		return join(this.root ?? this.projectPath, OPENSPEC_DIR, 'changes');
	}

	/**
	 * The directory of one change.
	 * @param {string} id - the change id.
	 * @returns {string} its absolute directory.
	 */
	changeDir(id) {
		return join(this.changesDir, id);
	}

	/**
	 * Run one CLI call.
	 *
	 * @param {string[]} args - arguments below `openspec`.
	 * @param {object} [options] - call options.
	 * @param {number} [options.timeoutMs] - override the call timeout.
	 * @param {string} [options.cwd] - override the working directory.
	 * @returns {Promise<string>} captured stdout.
	 * @throws {OpenspecError} when the binary is missing, times out, or exits non-zero.
	 */
	run(args, options = {}) {
		const executable = this.executable;
		if (executable === undefined) {
			return Promise.reject(
				new OpenspecError(
					`找不到 openspec 命令（配置为 "${this.command}"）。请确认已安装 OpenSpec，或在插件配置里指定绝对路径。`,
					{ command: this.command, args, code: null },
				),
			);
		}
		const cwd = options.cwd ?? this.projectPath;
		const timeout = options.timeoutMs ?? this.timeoutMs;
		return new Promise((resolvePromise, rejectPromise) => {
			execFile(
				executable,
				args,
				{ cwd, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8', env: process.env },
				(error, stdout, stderr) => {
					if (error === null || error === undefined) {
						resolvePromise(stdout ?? '');
						return;
					}
					const code = typeof error.code === 'number' ? error.code : null;
					const detail = {
						command: executable,
						args,
						code,
						stderr: typeof stderr === 'string' ? stderr.trim() : '',
					};
					const reason =
						error.killed === true
							? `openspec ${args.join(' ')} 超过 ${timeout} ms 未结束，已终止`
							: `openspec ${args.join(' ')} 失败（exit ${code ?? 'n/a'}）`;
					const tail = detail.stderr.length > 0 ? `：${detail.stderr.split('\n').slice(-3).join(' ')}` : '';
					rejectPromise(new OpenspecError(`${reason}${tail}`, detail));
				},
			);
		});
	}

	/**
	 * Run one CLI call and parse its JSON output.
	 * @param {string[]} args - arguments that produce `--json`.
	 * @returns {Promise<object>} the parsed document.
	 */
	async runJson(args) {
		const stdout = await this.run(args);
		try {
			return JSON.parse(stdout);
		} catch (error) {
			throw new OpenspecError(`openspec ${args.join(' ')} 的输出不是合法 JSON`, {
				command: this.executable,
				args,
				code: 0,
				stderr: String(stdout).slice(0, 400),
			});
		}
	}

	/**
	 * Initialize OpenSpec in the project.
	 * @returns {Promise<string>} the captured stdout.
	 */
	init() {
		return this.run(['init', '.', '--tools', 'none', '--no-animation']);
	}

	/**
	 * Every active change with its task tally.
	 * @returns {Promise<{ changes: object[], root: object }>} the CLI document.
	 */
	list() {
		return this.runJson(['list', '--json', '--no-color']);
	}

	/**
	 * The artifact completion report for one change.
	 * @param {string} id - the change id.
	 * @returns {Promise<object>} the CLI document.
	 */
	status(id) {
		return this.runJson(['status', '--change', id, '--json', '--no-color']);
	}

	/**
	 * The apply-phase contract: progress, the individual tasks, and the instruction.
	 * @param {string} id - the change id.
	 * @returns {Promise<object>} the CLI document.
	 */
	applyInfo(id) {
		return this.runJson(['instructions', 'apply', '--change', id, '--json', '--no-color']);
	}

	/**
	 * The authoring contract for one artifact: instruction, template, output path.
	 * @param {string} id - the change id.
	 * @param {string} artifact - `proposal`, `specs`, `design`, or `tasks`.
	 * @returns {Promise<object>} the CLI document.
	 */
	artifactInfo(id, artifact) {
		return this.runJson(['instructions', artifact, '--change', id, '--json', '--no-color']);
	}

	/**
	 * Create a change directory through the CLI, so its metadata is the CLI's own.
	 * @param {string} id - the change id.
	 * @param {string} [description] - a starting description for its README.
	 * @returns {Promise<object>} the CLI document.
	 */
	newChange(id, description) {
		const args = ['new', 'change', id, '--json', '--no-color'];
		if (typeof description === 'string' && description.trim().length > 0) {
			args.push('--description', description.trim());
		}
		return this.runJson(args);
	}

	/**
	 * Validate one change.
	 * @param {string} id - the change id.
	 * @param {boolean} [strict] - treat warnings as failures.
	 * @returns {Promise<string>} the captured report.
	 */
	validate(id, strict = false) {
		const args = ['validate', id, '--no-color'];
		if (strict) args.push('--strict');
		return this.run(args);
	}

	/**
	 * A one-line summary of the CLI's health in this project.
	 * @returns {{ available: boolean, executable: string | undefined, root: string | undefined, initialized: boolean }}
	 */
	describe() {
		const root = this.root;
		return {
			available: this.available,
			executable: this.executable,
			root,
			initialized: root !== undefined,
		};
	}
}

/**
 * The change ids that exist on disk for a project.
 *
 * Used to reconcile the durable list against the repository: a change deleted
 * with `git rm`, or one added by hand, must not leave the page lying. Read from
 * disk rather than from `openspec list`, because a change whose artifacts are
 * incomplete still exists.
 *
 * @param {string} projectPath - the project directory.
 * @returns {string[]} the change ids, excluding `archive`.
 */
export function changeIdsOnDisk(projectPath) {
	const root = findOpenspecRoot(projectPath);
	if (root === undefined) return [];
	const changesDir = join(root, OPENSPEC_DIR, 'changes');
	let entries = [];
	try {
		entries = readdirSync(changesDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && entry.name !== 'archive' && !entry.name.startsWith('.'))
		.map((entry) => entry.name)
		.sort();
}

/**
 * Read a change's proposal.md, for a title and a summary in the list.
 *
 * @param {string} changeDir - the change's directory.
 * @returns {{ title: string, summary: string }} whatever could be recovered.
 */
export function readProposalSummary(changeDir) {
	let text = '';
	try {
		text = readFileSync(join(changeDir, 'proposal.md'), 'utf8');
	} catch {
		return { title: '', summary: '' };
	}
	const lines = text.split('\n').map((line) => line.trim());
	let title = '';
	for (const line of lines) {
		if (line.startsWith('# ')) {
			title = line.slice(2).trim();
			break;
		}
	}
	// The first non-heading, non-comment prose paragraph is the closest thing to
	// a one-line summary these documents have.
	let summary = '';
	let buffer = [];
	const flush = () => {
		if (summary.length > 0) return true;
		const joined = buffer.join(' ').trim();
		if (joined.length > 0) summary = joined;
		buffer = [];
		return summary.length > 0;
	};
	for (const line of lines) {
		if (line.startsWith('#')) {
			if (line.startsWith('## ')) {
				// A section heading ends the preamble: only look before the first one.
				if (flush()) break;
			}
			continue;
		}
		if (line.startsWith('<!--')) continue;
		if (line.length === 0) {
			if (flush()) break;
			continue;
		}
		buffer.push(line);
	}
	flush();
	if (summary.length > 220) summary = `${summary.slice(0, 220)}…`;
	return { title, summary };
}
