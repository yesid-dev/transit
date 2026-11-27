/** A screen's readings when every one was asked: none is left out. */
export type Complete<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };

/** Whether a screen asks a reading: all of them, or only those named to be asked again. */
export function readingFilter(only?: ReadonlySet<string>) {
	return (name: string) => !only || only.has(name);
}
