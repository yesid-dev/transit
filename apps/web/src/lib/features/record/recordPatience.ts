import { getContext, setContext } from 'svelte';

const key = Symbol('record patience');
const recoveryKey = Symbol('record recovery');

type Register = (busy: boolean) => (success?: boolean) => void;

export function setRecordPatience(register: Register) {
	setContext(key, register);
}

export function getRecordPatience() {
	return getContext<Register | undefined>(key);
}

export function setRecordRecovered(recovered: () => void) {
	setContext(recoveryKey, recovered);
}

export function getRecordRecovered() {
	return getContext<(() => void) | undefined>(recoveryKey);
}

const retryKey = Symbol('record retry');

/** Offers the screen's one "Try again" for readings that could not arrive; returns its removal. */
type RegisterRetry = (tryAgain: () => void) => () => void;

export function setRecordRetry(register: RegisterRetry) {
	setContext(retryKey, register);
}

export function getRecordRetry() {
	return getContext<RegisterRetry | undefined>(retryKey);
}
