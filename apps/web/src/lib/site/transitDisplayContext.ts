import { getContext, setContext } from 'svelte';
import { getLocale } from '#lib/i18n/index.ts';
import { routeNameFallback } from './absence';
import { createLineDirectory, type LineDirectory } from './lineDirectory';
import { directionLabel, directionName, towardReading } from './presenter';
import { formatTransitName } from './transitDisplay';
import type { Locale } from '#lib/i18n/copy.ts';

const KEY = Symbol.for('transit.line-directory');
export function setLineDirectory(reader: () => LineDirectory): void {
	setContext(KEY, reader);
}

/** Optional so reusable detail rows can also render outside a booted page. */
export function transitDisplay() {
	const locale = getLocale();
	const reader = getContext<(() => LineDirectory) | undefined>(KEY);
	const fallback = createLineDirectory(null, { line: (id) => routeNameFallback(id, locale) });
	const directory = () => reader?.() ?? fallback;
	return {
		get directory() {
			return directory();
		},
		line: (id: string) => directory().number(id),
		lineName: (id: string, name?: string | null) => directory().name(id, name),
		readName: (name: string, lang: Locale) =>
			formatTransitName(name, lang, directory().nameSeparators),
		directionName: (
			name: string | null | undefined,
			lang: Locale,
			place: 'sentence' | 'cell' = 'sentence',
		) => directionName(name, lang, directory().nameSeparators, place),
		toward: (name: string, lang: Locale, capital = true) =>
			towardReading(name, lang, directory().nameSeparators, capital),
		/** With `line`, a compass headsign is first resolved to the line's terminus. */
		directionLabel: (
			direction: string | number | null | undefined,
			headsigns: Readonly<Record<number, string>>,
			lang: Locale,
			line?: string | null,
		) =>
			directionLabel(
				direction,
				line
					? Object.fromEntries(
							Object.entries(headsigns).map(([key, sign]) => [
								key,
								directory().headsign(line, sign) ?? sign,
							]),
						)
					: headsigns,
				lang,
				directory().nameSeparators,
			),
	};
}
