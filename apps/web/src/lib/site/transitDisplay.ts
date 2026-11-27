import type { OccupancyCode } from '#lib/v1/index.ts';
import type { Locale } from '#lib/i18n/copy.ts';
import type { NameSeparators } from '#lib/v1/schemas/providers.ts';

export function lineLabel(
	id: string,
	routes: readonly { id: string; short: string }[] = [],
): string {
	return routes.findLast((route) => route.id === id)?.short || id;
}

type NameParts = [string] | [string, string];

function splitName(name: string, separator: string): NameParts | null {
	const [left, right, ...extra] = name.split(separator);
	if (right === undefined) return [name];
	if (extra.length || !left?.trim() || !right.trim() || !/\s$/u.test(left) || !/^\s/u.test(right))
		return null;
	return [left.trim(), right.trim()];
}

function transitNameParts(name: string, rule: NameSeparators): NameParts[] | null {
	const endpoints = splitName(name, rule.ends);
	if (!endpoints) return null;

	const parts: NameParts[] = [];
	for (const endpoint of endpoints) {
		const pair = splitName(endpoint, rule.languages);
		if (!pair) return null;
		// A conjunction on one side can join a shared name to a bilingual name.
		// Without matching structure, choosing a side could drop that shared name.
		if (
			pair.length === 2 &&
			[' / ', ' & '].some((join) => pair[0].includes(join) !== pair[1].includes(join))
		)
			return null;
		parts.push(pair);
	}
	return parts;
}

/** An apostrophe inside a word, as agencies publish it ("l'Acadie"), set as the typographic one. */
export function typographicApostrophes(text: string): string {
	return text.replace(/(?<=\p{L})'(?=\p{L})/gu, '’');
}

export function formatTransitName(name: string, locale: Locale, rule?: NameSeparators): string {
	const parts = rule ? transitNameParts(name, rule) : null;
	if (!rule || !parts) return typographicApostrophes(name);
	const side = rule.language_order[0] === locale ? 0 : 1;
	return typographicApostrophes(parts.map((part) => part[side] ?? part[0]).join(' / '));
}

export function transitNameAliases(
	name: string | null | undefined,
	rule?: NameSeparators,
): string[] {
	if (!name || !rule) return [];
	return transitNameParts(name, rule)?.flatMap((part) => (part.length === 2 ? part : [])) ?? [];
}

// Short tokens and codes the agency writes in capitals stay as published.
const abbreviations = new Set([
	'NB',
	'SB',
	'EB',
	'WB',
	'O-TRAIN',
	'UOTTAWA',
	'H.S.',
	'AD.',
	'TD',
	'OC',
	'POB',
]);
const particles = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'au', 'aux', 'sur']);
const capital = (word: string) => word.charAt(0).toLocaleUpperCase() + word.slice(1);

/**
 * One word of a name in capitals, in title case. "Mc" keeps the capital after it (McArthur). After
 * an apostrophe the name starts again: O' keeps its capital (O'Connor), and the French elisions
 * l' and d' read as particles (de l'Église, D'Iberville at the start). "Mac" is left alone: the
 * same prefix is written both ways (Macdonald-Cartier, MacLaren), so no rule can choose.
 */
function titleWord(lower: string, leading: boolean): string {
	const elided = /^(\p{L}{1,2})(['’])(\p{L}.*)$/u.exec(lower);
	if (elided) {
		const [, prefix, mark, rest] = elided;
		const head = prefix === 'o' || leading ? capital(prefix) : prefix;
		return head + mark + titleWord(rest, true);
	}
	if (particles.has(lower) && !leading) return lower;
	if (/^mc\p{L}{2}/u.test(lower)) return 'Mc' + capital(lower.slice(2));
	return capital(lower);
}

/** A name the agency writes in capitals, in title case; any other name stays as published. */
export function stopDisplayName(name: string): string {
	const withOrdinals = name.replace(
		/\b(\d+)(ST|ND|RD|TH)\b/g,
		(_, number, suffix) => number + suffix.toLowerCase(),
	);
	if (name !== name.toLocaleUpperCase() || !/\p{L}/u.test(name))
		return typographicApostrophes(withOrdinals);
	return typographicApostrophes(withOrdinals).replace(
		/[\p{L}\p{N}]+(?:[.'’-][\p{L}\p{N}]+)*\.?/gu,
		(word, offset: number) => {
			if (abbreviations.has(word) || /^[A-Z]$/.test(word) || /\d/.test(word)) return word;
			return word
				.split('-')
				.map((part, index) => {
					if (abbreviations.has(part)) return part;
					// A particle stays lowercase except as the first word of the name.
					return titleWord(part.toLocaleLowerCase(), offset === 0 && index === 0);
				})
				.join('-');
		},
	);
}

export function hasOccupancy(
	declared: boolean | undefined,
	vehicles: readonly { occupancy?: OccupancyCode | null }[],
): boolean {
	return declared === true || vehicles.some((v) => v.occupancy != null);
}
