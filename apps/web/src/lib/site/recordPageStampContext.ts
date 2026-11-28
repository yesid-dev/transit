import { getContext, setContext } from 'svelte';
import { delocalizePath } from '#lib/i18n/routing.ts';

const KEY = Symbol('record page stamp');

/** The page's Record stamp; it is set only while the page shows a Record frame. */
export function provideRecordPageStamp(read: () => string | undefined) {
	setContext(KEY, read);
}

export function readRecordPageStamp() {
	return getContext<(() => string | undefined) | undefined>(KEY) ?? (() => undefined);
}

/** The context a component reads when it renders inside a Record page, for tests and harnesses. */
export function recordPageStampContext(label: string | undefined) {
	return new Map([[KEY, () => label]]);
}

/** The report screens whose Record view offers Print even when its address names no frame. */
const reportPaths = new Set(['/', '/network', '/alerts', '/status']);

/** Whether a page's Record actions include Print: a Record frame named in the address, or a report's Record view. */
export function recordPrints(
	url: { pathname: string; searchParams: { get(name: string): string | null } } | undefined,
	recordStamp: string | undefined,
) {
	if (!url) return false;
	if (url.searchParams.get('frameMode') === 'record') return true;
	const path = delocalizePath(url.pathname).replace(/\/$/, '') || '/';
	return Boolean(recordStamp) && reportPaths.has(path);
}
