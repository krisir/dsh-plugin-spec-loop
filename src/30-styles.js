/**
 * The page stylesheet.
 *
 * Every colour comes from a `--dsw-*` theme token. That is not a stylistic
 * preference: the same page has to read correctly in the light and the dark
 * theme, and a raw hex value is exactly the thing that works in one and becomes
 * unreadable in the other.
 *
 * One `<style>` element is inserted per document and keyed by a marker attribute,
 * so hot-reloading the plugin twice does not accumulate copies.
 */

/** The marker that identifies this plugin's stylesheet. */
const STYLE_MARKER = 'data-dsh-spec-loop-style';

/** The stylesheet text. */
const STYLESHEET = `
.sl-root {
	display: flex;
	flex-direction: column;
	gap: 16px;
	height: 100%;
	min-height: 0;
	overflow: auto;
	padding: 16px 20px 40px;
	box-sizing: border-box;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-base);
	font-size: 13px;
	line-height: 1.6;
}

.sl-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.sl-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sl-title { font-size: 17px; font-weight: 600; }
.sl-subtitle { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.sl-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.sl-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.sl-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46ch; }

.sl-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sl-row-end { margin-left: auto; }

.sl-btn {
	appearance: none;
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-1);
	color: var(--dsw-alias-label-primary);
	border-radius: 7px;
	padding: 4px 11px;
	font-size: 12px;
	line-height: 1.7;
	cursor: pointer;
	font-family: inherit;
	white-space: nowrap;
}
.sl-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.sl-btn:disabled { opacity: 0.5; cursor: default; }
.sl-btn-primary {
	background: var(--dsw-alias-brand-primary);
	border-color: var(--dsw-alias-brand-primary);
	color: var(--dsw-alias-bg-base);
	font-weight: 600;
}
.sl-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); opacity: 0.9; }
.sl-btn-quiet { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.sl-btn-quiet:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }

.sl-card {
	border: 1px solid var(--dsw-alias-border-l1);
	background: var(--dsw-alias-bg-layer-1);
	border-radius: 11px;
	padding: 14px 16px;
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.sl-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.sl-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }

.sl-textarea {
	width: 100%;
	box-sizing: border-box;
	min-height: 96px;
	max-height: 320px;
	resize: vertical;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 8px;
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
	padding: 9px 11px;
	font-family: inherit;
	font-size: 13px;
	line-height: 1.6;
}
.sl-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }

.sl-input {
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 7px;
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
	padding: 4px 8px;
	font-family: inherit;
	font-size: 12.5px;
}
.sl-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.sl-input-num { width: 68px; }
.sl-input-wide { width: 100%; box-sizing: border-box; }

.sl-pill {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	border-radius: 999px;
	padding: 1px 9px;
	font-size: 11.5px;
	font-weight: 600;
	border: 1px solid transparent;
	white-space: nowrap;
}
.sl-pill::before {
	content: '';
	width: 6px;
	height: 6px;
	border-radius: 999px;
	background: currentColor;
	flex: none;
}
.sl-tone-idle { color: var(--dsw-alias-state-idle-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.sl-tone-busy { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.sl-tone-ok { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.sl-tone-warn { color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.sl-tone-error { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }

.sl-list { display: flex; flex-direction: column; gap: 10px; }
.sl-change { display: flex; flex-direction: column; gap: 9px; }
.sl-change-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.sl-change-id { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.sl-change-title { color: var(--dsw-alias-label-secondary); font-size: 12px; min-width: 0; }
.sl-change-summary { color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: pre-wrap; }
.sl-change-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.sl-bar { height: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.sl-bar-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width 240ms ease; }
.sl-bar-fill-ok { background: var(--dsw-alias-state-success-primary); }

.sl-details { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 9px; display: flex; flex-direction: column; gap: 8px; }
.sl-log { display: flex; flex-direction: column; gap: 6px; }
.sl-log-entry {
	border-left: 2px solid var(--dsw-alias-border-l2);
	padding: 3px 0 3px 9px;
	display: flex;
	flex-direction: column;
	gap: 2px;
}
.sl-log-entry-error { border-left-color: var(--dsw-alias-state-error-primary); }
.sl-log-entry-ok { border-left-color: var(--dsw-alias-state-success-primary); }
.sl-log-entry-warn { border-left-color: var(--dsw-alias-state-warn-primary); }
.sl-log-head { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.sl-log-note { color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: pre-wrap; word-break: break-word; }

.sl-notice {
	border-radius: 9px;
	padding: 9px 12px;
	font-size: 12.5px;
	border: 1px solid var(--dsw-alias-border-l1);
	background: var(--dsw-alias-bg-layer-2);
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
}
.sl-notice-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.sl-notice-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.sl-notice-ok { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }

.sl-settings-grid { display: grid; grid-template-columns: auto 1fr; gap: 10px 14px; align-items: start; }
.sl-settings-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.sl-checkbox { display: flex; align-items: center; gap: 7px; }

.sl-spinner {
	display: inline-block;
	width: 11px;
	height: 11px;
	border: 2px solid var(--dsw-alias-border-l2);
	border-top-color: var(--dsw-alias-brand-primary);
	border-radius: 999px;
	animation: sl-spin 700ms linear infinite;
	flex: none;
}
@keyframes sl-spin { to { transform: rotate(360deg); } }

.sl-empty { color: var(--dsw-alias-label-secondary); font-size: 12.5px; padding: 18px 4px; text-align: center; }

.sl-code {
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 12px;
	padding: 1px 5px;
	border-radius: 5px;
	background: var(--dsw-alias-bg-layer-2);
	border: 1px solid var(--dsw-alias-border-l1);
	color: var(--dsw-alias-label-primary);
}
.sl-copy { margin: 0; font-size: 12.5px; color: var(--dsw-alias-label-secondary); display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }

.sl-proposal { display: flex; flex-direction: column; gap: 7px; padding: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); }
.sl-proposal-off { opacity: 0.55; }
.sl-proposal-head { display: flex; align-items: center; gap: 8px; }
.sl-proposal-title { flex: 1; min-width: 0; font-weight: 600; }
.sl-proposal-summary { min-height: 38px; font-size: 12px; resize: vertical; font-family: inherit; }
.sl-proposal-id { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.sl-check { width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary); flex: none; cursor: pointer; }

@media (prefers-reduced-motion: reduce) {
	.sl-bar-fill { transition: none; }
	.sl-spinner { animation-duration: 2s; }
}
`;

/**
 * Insert the stylesheet once per document.
 * @returns {() => void} a disposer that removes it.
 */
function installStyles() {
	if (typeof document === 'undefined') return () => {};
	const existing = document.querySelector(`style[${STYLE_MARKER}]`);
	if (existing !== null) return () => {};
	const style = document.createElement('style');
	style.setAttribute(STYLE_MARKER, '');
	style.textContent = STYLESHEET;
	document.head.appendChild(style);
	return () => {
		style.remove();
	};
}
