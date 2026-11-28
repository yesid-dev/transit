import { getContext, setContext } from 'svelte';

const KEY = Symbol('record page stamp');

export function provideRecordPageStamp(read: () => string | undefined) {
	setContext(KEY, read);
}

export function readRecordPageStamp() {
	return getContext<(() => string | undefined) | undefined>(KEY) ?? (() => undefined);
}
