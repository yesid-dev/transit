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

export function formatTransitName(name: string, locale: Locale, rule?: NameSeparators): string {
	if (!rule) return name;
	const parts = transitNameParts(name, rule);
	if (!parts) return name;
	const side = rule.language_order[0] === locale ? 0 : 1;
	return parts.map((part) => part[side] ?? part[0]).join(' / ');
}

export function transitNameAliases(
	name: string | null | undefined,
	rule?: NameSeparators,
): string[] {
	if (!name || !rule) return [];
	return transitNameParts(name, rule)?.flatMap((part) => (part.length === 2 ? part : [])) ?? [];
}

const abbreviations = new Set(['NB', 'SB', 'EB', 'WB', 'O-TRAIN', 'UOTTAWA', 'H.S.', 'AD.']);
const particles = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'au', 'aux', 'sur']);

export function stopDisplayName(name: string): string {
	const withOrdinals = name.replace(
		/\b(\d+)(ST|ND|RD|TH)\b/g,
		(_, number, suffix) => number + suffix.toLowerCase(),
	);
	if (name !== name.toLocaleUpperCase() || !/\p{L}/u.test(name)) return withOrdinals;
	return withOrdinals.replace(
		/[\p{L}\p{N}]+(?:[.'’-][\p{L}\p{N}]+)*\.?/gu,
		(word, offset: number) => {
			if (abbreviations.has(word) || /^[A-Z]$/.test(word) || /\d/.test(word)) return word;
			return word
				.split('-')
				.map((part, index) => {
					if (abbreviations.has(part)) return part;
					const lower = part.toLocaleLowerCase();
					// A particle stays lowercase except as the first word of the name.
					const leading = offset === 0 && index === 0;
					return particles.has(lower) && !leading
						? lower
						: lower[0]!.toLocaleUpperCase() + lower.slice(1);
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
