import { getContext, setContext } from 'svelte';

const KEY = Symbol('record-period-notice');

/** One notice when a link's requested dates are outside the city's record. */
export function provideRecordPeriodNotice(read: () => string | null): void {
	setContext(KEY, read);
}

/** Read during component setup; the returned getter follows the current page. */
export function recordPeriodNoticeReader(): () => string | null {
	return getContext<(() => string | null) | undefined>(KEY) ?? (() => null);
}
