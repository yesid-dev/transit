import { getContext, setContext } from 'svelte';

const key = Symbol('record patience');

type Register = (busy: boolean) => (success?: boolean) => void;

export function setRecordPatience(register: Register) {
	setContext(key, register);
}

export function getRecordPatience() {
	return getContext<Register | undefined>(key);
}
