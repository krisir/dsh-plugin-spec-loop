import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Evaluate one src file for its top-level declarations. */
function loadSource(name, exported) {
	const source = readFileSync(join(root, 'src', name), 'utf8');
	// eslint-disable-next-line no-new-func
	return new Function(`${source}\nreturn { ${exported.join(', ')} };`)();
}

const { zh, en } = loadSource('05-locale.js', ['zh', 'en']);
const { STATUS_KEYS } = loadSource('00-util.js', ['STATUS_KEYS']);

test('the English dictionary covers every Chinese key', () => {
	const missing = Object.keys(zh).filter((key) => !(key in en));
	assert.deepEqual(missing, [], 'keys present in zh but not en');
});

test('the dictionaries have no key the other one lacks', () => {
	const extra = Object.keys(en).filter((key) => !(key in zh));
	assert.deepEqual(extra, [], 'keys present in en but not zh');
});

test('every literal key the page asks for exists', () => {
	const requested = new Set();
	for (const name of readdirSync(join(root, 'src'))) {
		if (!name.endsWith('.js')) continue;
		const body = readFileSync(join(root, 'src', name), 'utf8');
		for (const match of body.matchAll(/\bt\(\s*'([^']+)'/g)) requested.add(match[1]);
	}
	// The status pill and the round-log status are built from a template, so the
	// literal scan cannot see them; name them explicitly instead.
	for (const status of STATUS_KEYS) requested.add(`status.${status}`);
	for (const status of ['ok', 'error', 'timeout', 'cancelled']) requested.add(`log.${status}`);
	const missing = [...requested].filter((key) => !(key in zh));
	assert.deepEqual(missing, [], 'keys used by the page but missing from the dictionary');
});

test('every status the host can report has a label', () => {
	for (const status of STATUS_KEYS) {
		assert.ok(typeof zh[`status.${status}`] === 'string' && zh[`status.${status}`].length > 0, status);
	}
});

test('the built bundle registers one client plugin and requires nothing but react', () => {
	const bundle = readFileSync(join(root, 'client.js'), 'utf8');
	const required = [...bundle.matchAll(/require\((["'])([^"']+)\1\)/g)].map((match) => match[2]);
	assert.deepEqual([...new Set(required)], ['react']);

	let captured;
	globalThis.window = { __ModuleLoader__: { load: (module) => { captured = module; } } };
	try {
		// eslint-disable-next-line no-new-func
		new Function(bundle)();
	} finally {
		delete globalThis.window;
	}
	assert.equal(captured.id, 'dsh-plugin-spec-loop');

	const react = {
		createElement: (...args) => ({ args }),
		useState: (value) => [value, () => {}],
		useEffect: () => {},
		useLayoutEffect: () => {},
		useRef: (value) => ({ current: value }),
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
	};
	const exports = captured.factory((specifier) => {
		if (specifier === 'react') return react;
		throw new Error(`unexpected require("${specifier}")`);
	});
	assert.deepEqual(exports.inject, ['slots', 'locale']);
	assert.equal(typeof exports.apply, 'function');
});

test('applying the client plugin registers one view at order 30 and installs its stylesheet', () => {
	const bundle = readFileSync(join(root, 'client.js'), 'utf8');
	let captured;
	globalThis.window = { __ModuleLoader__: { load: (module) => { captured = module; } } };
	try {
		// eslint-disable-next-line no-new-func
		new Function(bundle)();
	} finally {
		delete globalThis.window;
	}
	const react = {
		createElement: (...args) => ({ args }),
		useState: (value) => [value, () => {}],
		useEffect: () => {},
		useLayoutEffect: () => {},
		useRef: (value) => ({ current: value }),
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
	};
	const exports = captured.factory(() => react);

	const effects = [];
	const registrations = [];
	const ctx = {
		effect: (fn, label) => {
			effects.push(label);
			return fn();
		},
		locale: { register: () => {}, bind: () => (key) => key },
		slots: {
			inject: (slot, fn) => fn(),
			register: (options, component) => {
				registrations.push({ options, component });
				return () => {};
			},
		},
	};
	exports.apply(ctx);

	assert.equal(registrations.length, 1);
	assert.equal(registrations[0].options.name, 'conversation.view');
	assert.equal(registrations[0].options.id, 'spec-loop');
	assert.equal(registrations[0].options.order, 30);
	assert.equal(registrations[0].options.locale, 'specLoop');
	assert.equal(registrations[0].options.label(), 'view.label');
	assert.deepEqual(registrations[0].options.inject('session-1'), { sessionId: 'session-1' });
	assert.equal(typeof registrations[0].component, 'function');
	assert.ok(effects.some((label) => String(label).includes('stylesheet')));
	assert.ok(effects.some((label) => String(label).includes('dictionaries')));
});
