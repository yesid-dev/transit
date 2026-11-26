import { getContext, setContext } from 'svelte';

const KEY = Symbol('record-start-notice');

/** The shell says, once per screen, when a link's dates fell before the city's record. */
export function provideRecordStartNotice(read: () => string | null): void {
	setContext(KEY, read);
}

/** Read during component setup; the returned getter follows the current page. */
export function recordStartNoticeReader(): () => string | null {
	return getContext<(() => string | null) | undefined>(KEY) ?? (() => null);
}
