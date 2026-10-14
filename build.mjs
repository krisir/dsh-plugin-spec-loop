#!/usr/bin/env node
/**
 * Build `client.js` from the numbered sources in `src/`.
 *
 * The browser bundle format the DSH client module system consumes is a single
 * self-contained script that registers one lazy factory:
 *
 *     window.__ModuleLoader__.load({ id, factory(require) { ... } })
 *
 * Relative `require()` calls inside a factory are NOT resolved — only the
 * platform seed words and already-materialized modules are. So the sources are
 * concatenated into one factory body instead of bundled, and every source file
 * shares that single function scope. That is why the files are numbered:
 * `function` declarations hoist, but `const` initialisers run in filename order.
 *
 * The only module taken from the seed table is `react`. The DSH client packages
 * are deliberately not imported: a plain-JS plugin has no type check against
 * them, they change without notice, and a throwing component blanks the slot
 * entry it was registered into.
 *
 * This file is both a script and a module. Run it to write `client.js`; import
 * it to get `PREAMBLE`, `sourceFiles` and `evaluateSources` — the render tests
 * use the last one so they build the component scope exactly the way the bundle
 * does, instead of keeping a second copy of the preamble in step by hand.
 *
 * Usage: node build.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

/**
 * The factory preamble: the seed words the bundle is allowed to take, plus the
 * `h` and hook aliases the sources are written against.
 *
 * @type {string}
 */
export const PREAMBLE = `const React = require("react");
const { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } = React;
const h = React.createElement;`;

/**
 * The internals the render tests pull out of the evaluated scope.
 *
 * The published bundle exports only `inject` and `apply` — that is the surface
 * the client host calls. The components are named here so a test can render them
 * without widening that surface.
 *
 * @type {string[]}
 */
export const TEST_EXPORTS = [
	'inject',
	'apply',
	'SpecLoopPage',
	// The page body without its polling, so a test can render the *loaded* page
	// rather than only the pre-snapshot state `SpecLoopPage` can reach on its own.
	'SpecLoopView',
	'CommandHint',
	'DiscussionPanel',
	'ProposalPanel',
	'ProposalEntry',
	'DiscardButton',
	'SettingsPanel',
	'ChangeCard',
	'StatusPill',
	'ProgressBar',
	'useLoopState',
	'api',
	'zh',
	'en',
];

/** The source file names, in the order they are concatenated. */
export function sourceFiles() {
	const files = readdirSync(srcDir)
		.filter((name) => name.endsWith('.js'))
		.sort();
	if (files.length === 0) throw new Error('build: no sources in src/');
	return files;
}

/** The concatenated source body, without the preamble. */
function sourceBody() {
	return sourceFiles()
		.map((name) => readFileSync(join(srcDir, name), 'utf8').replace(/\n$/, ''))
		.join('\n');
}

/**
 * Evaluate the sources as one shared scope and return the named internals.
 *
 * @param {object} React - the React module to hand the sources.
 * @param {string[]} [names] - which internals to return; `TEST_EXPORTS` by default.
 * @returns {object} the requested values.
 */
export function evaluateSources(React, names = TEST_EXPORTS) {
	// eslint-disable-next-line no-new-func
	const factory = new Function(
		'require',
		`${PREAMBLE}\n${sourceBody()}\nreturn { ${names.join(', ')} };`,
	);
	return factory((specifier) => {
		if (specifier === 'react') return React;
		throw new Error(`build: evaluateSources may not require("${specifier}")`);
	});
}

/** Render the bundle text. Throws on the two mistakes a browser would hide. */
export function renderBundle() {
	const files = sourceFiles();

	const banner = `/**
 * ${pkg.name} — browser half.
 *
 * GENERATED FILE — do not edit. Edit src/*.js and run \`node build.mjs\`.
 * Sources are concatenated in filename order into one factory body; see
 * build.mjs for why they cannot be separate modules.
 */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

${PREAMBLE.split('\n')
	.map((line) => `\t\t${line}`)
	.join('\n')}

`;

	const chapters = files.map((name) => {
		const body = readFileSync(join(srcDir, name), 'utf8');
		return `\t\t//#region src/${name}\n${body.replace(/\n$/, '')}\n\t\t//#endregion\n`;
	});

	const footer = `
\t\texports.inject = inject;
\t\texports.apply = apply;
\t\treturn module.exports;
\t},
});
`;

	// A whole stylesheet is held in a template literal, so a single backtick in a
	// CSS comment closes it early and the build fails with a syntax error pointing
	// at the wrong place. Check the literal bodies directly and say what is wrong.
	for (const name of files) {
		const body = readFileSync(join(srcDir, name), 'utf8');
		for (const match of body.matchAll(/=\s*`([\s\S]*?)`;/g)) {
			if (match[1].includes('`')) {
				throw new Error(
					`build: ${name} has a backtick inside a template literal. ` +
						'In a stylesheet that means a backtick in a CSS comment — remove it.',
				);
			}
		}
	}

	// Guard the one invariant the runtime cannot check for us: the bundle may only
	// require seed words. A relative or third-party specifier would throw at
	// materialization time, inside the browser, where the failure is a blank panel.
	const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']);
	const out = banner + chapters.join('\n') + footer;
	for (const match of out.matchAll(/require\((["'])([^"']+)\1\)/g)) {
		if (!allowed.has(match[2])) {
			throw new Error(`build: client.js may not require("${match[2]}") — only react ships in the client seed table`);
		}
	}
	return { out, count: files.length };
}

/** Write `client.js`. */
export function build() {
	const { out, count } = renderBundle();
	writeFileSync(join(here, 'client.js'), out);
	process.stdout.write(`built client.js from ${count} sources (${out.length} bytes)\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) build();
