import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';

// Endonyms and product names retain their official spelling in French copy.
const properNouns = ['English', 'Cloudflare Web Analytics', 'Plausible Analytics Cloud'];
const forbidden =
	/\b(?:Contains|pipeline|gate|trips?|voyages?|Slowest|BUILD|English|proxy|rollup|bus-moments|hors-norme)\b|chaîne de traitement|registre des méthodes|génération de publication|filigran[ée]|dépassement physique|transport routier|\bvers (?:est|ouest|nord|sud)\b/gi;

/**
 * Québec glossary and typography (fix wave W6). Each class is one error a reviewer found on
 * screen: the word riders would misread, or the slip a French reader notices.
 */
const glossary: [RegExp, string, exceptIn?: RegExp][] = [
	// Crowding is how full a vehicle is; "achalandage" is ridership, which Transit does not measure.
	[/achalandage/i, 'achalandage (use Occupation or Places à bord)'],
	// The agency is "la société de transport", never "l’agence" or "l’exploitant". In the legal
	// pages "l’exploitant" is the person who runs Transit, not a transit agency.
	[
		/(?<!\p{L})(?:l['’]agence|l['’]exploitant|agences?(?!\p{L}))/iu,
		'agence or exploitant',
		/^features\/legal\//,
	],
	// The record is a "bilan"; "historique" is how deep the kept data goes, never the record.
	[
		/l['’]historique (?:commence|sur la carte)|couvertes par l['’]historique/i,
		'historique for the record',
	],
	// One label per idea.
	[
		/Jour après jour|^Décompte\b|Décompte\s*:/,
		'second label for Jour par jour or Ce qui est compté',
	],
	[/Ordre des lignes/, 'Ordre des lignes (use Ordre du classement)'],
	// A web route is not a road.
	[/ROUTE INTROUVABLE|route demandée/i, 'route for a page'],
	// The Controls pill holds options, not orders.
	[/^Commandes$/, 'Commandes (use Options)'],
	// A terminus that starts with a particle needs a noun: "vers l’arrêt du …", never "vers du …".
	[
		/(?<!\p{L})(?:vers (?:du |de la |d['’])|de (?:du|des|de la) |à du )/iu,
		'a particle after vers, de or à',
	],
	// Typography: a no-break space before "%" and ":", and the typographic apostrophe.
	[/\d%|\d %/, 'no no-break space before %'],
	[/\p{L}'\p{L}/u, 'straight apostrophe'],
	// The spoken "alors" reads as a chat; prose says "donc".
	[/, alors les\b/, 'spoken alors'],
];

/**
 * Screens whose words other packets of the same wave rewrite (alerts in W9, the map in W10). The
 * glossary reads them once those land: delete this line then.
 */
const inFlight = /^features\/(?:alerts\/|map\/|lines\/LineLiveNotices\.svelte$)/;

// Use the Svelte parser, not a regex, to find a component's script blocks.
function svelteScripts(raw: string): string {
	const ast = parse(raw, { modern: true });
	return [ast.module, ast.instance]
		.filter((script) => script != null)
		.map((script) => {
			// The parser adds source offsets that estree's Program type does not declare.
			const { start, end } = script.content as unknown as { start: number; end: number };
			return raw.slice(start, end);
		})
		.join('\n');
}

/** Every expression in a component's markup, as source text each TypeScript can parse alone. */
function svelteMarkupExpressions(raw: string): string {
	const ast = parse(raw, { modern: true });
	const found: string[] = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (node === null || typeof node !== 'object') return;
		const { type, start, end } = node as { type?: string; start?: number; end?: number };
		if (
			typeof type === 'string' &&
			/Expression$|^TemplateLiteral$/.test(type) &&
			typeof start === 'number' &&
			typeof end === 'number'
		) {
			found.push(`(${raw.slice(start, end)});`);
			return;
		}
		for (const value of Object.values(node)) walk(value);
	};
	walk(ast.fragment);
	return found.join('\n');
}

function sourceFiles() {
	const root = fileURLToPath(new URL('../', import.meta.url));
	const files = readdirSync(root, { recursive: true, withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() && /\.(ts|svelte)$/.test(entry.name) && !/test|fixture/i.test(entry.name),
		)
		.map((entry) => `${entry.parentPath}/${entry.name}`)
		.sort();
	return { root, files };
}

function stringText(node: ts.Node): string | null {
	if (
		ts.isStringLiteralLike(node) ||
		ts.isTemplateMiddleOrTemplateTail(node) ||
		ts.isTemplateHead(node)
	)
		return node.text;
	return null;
}

/** A condition that chooses French: `locale === 'fr'`, `lang === 'fr'` or a `fr` flag. */
function choosesFrench(condition: ts.Expression, ast: ts.SourceFile) {
	const text = condition.getText(ast).trim();
	return /^(?:\w+(?:\.\w+)*\s*===\s*['"]fr['"]|['"]fr['"]\s*===\s*\w+(?:\.\w+)*|fr|french)$/.test(
		text,
	);
}

/** Every French string in a file: `fr:` copy, the French branch of a choice, and t(en, fr). */
function frenchStrings(file: string): { path: string; text: string }[] {
	const raw = readFileSync(file, 'utf8');
	const sources = file.endsWith('.svelte')
		? [svelteScripts(raw), svelteMarkupExpressions(raw)]
		: [raw];
	const found: { path: string; text: string }[] = [];
	for (const source of sources) {
		const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node, french = false): void => {
			if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'fr')
				return visit(node.initializer, true);
			if (ts.isConditionalExpression(node) && choosesFrench(node.condition, ast)) {
				visit(node.condition, french);
				visit(node.whenTrue, true);
				return visit(node.whenFalse, french);
			}
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				['t', 'choose'].includes(node.expression.text)
			) {
				const frIndex = node.expression.text === 't' ? 1 : 2;
				node.arguments.forEach((argument, index) => visit(argument, french || index === frIndex));
				return;
			}
			const text = french ? stringText(node) : null;
			if (text !== null && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node))
				found.push({ path: file, text });
			ts.forEachChild(node, (child) => visit(child, french));
		};
		visit(ast);
	}
	return found;
}

describe('French copy', () => {
	const { root, files } = sourceFiles();
	const strings = files.flatMap(frenchStrings).map(({ path, text }) => ({
		path: path.slice(root.length).replaceAll('\\', '/'),
		text: properNouns.reduce((value, name) => value.replaceAll(name, ''), text),
	}));

	it('finds French strings in copy objects, choices and t() calls', () => {
		expect(files.length).toBeGreaterThan(0);
		const where = new Set(strings.map(({ path }) => path));
		// One of each kind: a fr: copy object, a locale choice in TypeScript, a t() call in markup.
		expect(where).toContain('site/presenter.copy.ts');
		expect(
			strings.some(({ text }) => text === 'Aucun véhicule dans les 15 prochaines minutes.'),
		).toBe(true);
		expect(where).toContain('features/stops/StopPredictionTable.svelte');
	});

	it('keeps known English labels and voyage out of French copy', () => {
		const findings = strings
			.map(({ path, text }) => ({ path, text, matches: text.match(forbidden) }))
			.filter(({ matches }) => matches)
			.map(({ path, text, matches }) => `${path}: ${matches!.join(', ')} in ${text}`);
		expect(findings).toEqual([]);
	});

	it('follows the Québec glossary and typography', () => {
		const findings = strings
			.filter(({ path }) => !inFlight.test(path))
			.flatMap(({ path, text }) =>
				glossary
					.filter(([pattern, , exceptIn]) => pattern.test(text) && !exceptIn?.test(path))
					.map(([, why]) => `${path}: ${why} in ${text}`),
			);
		expect(findings).toEqual([]);
	});
});

describe('the glossary patterns', () => {
	const flags = (text: string) =>
		glossary.filter(([pattern]) => pattern.test(text)).map(([, why]) => why);

	it('flag each class of error once', () => {
		for (const wrong of [
			'Niveau d’achalandage',
			'Prévisions de l’agence pour cet arrêt.',
			'Annulés, avec avis de l’exploitant',
			'L’historique commence en octobre 2026.',
			'Jour après jour',
			'Décompte : ',
			'Ordre des lignes',
			'ROUTE INTROUVABLE',
			'Commandes',
			'Vers du Square-Victoria / Saint-Antoine (est)',
			'inférieurs à 50% de',
			"L’arrêt d’à côté n'a rien",
			'Les flux ne le montrent pas, alors les trajets non terminés',
		])
			expect(flags(wrong), wrong).toHaveLength(1);
	});

	it('pass the approved wording', () => {
		for (const right of [
			'Places à bord',
			'Occupation',
			'Prévisions de la société de transport pour cet arrêt.',
			'Prévu à 4 h 48',
			'Le bilan commence en octobre 2026.',
			'tout l’historique conservé',
			'Jour par jour',
			'Ce qui est compté\u00a0: ',
			'Ordre du classement',
			'Page introuvable',
			'Options',
			'Vers l’arrêt du Square-Victoria / Saint-Antoine (est)',
			'De Gare Montréal-Ouest à Station Laurier',
			'inférieurs à 50\u00a0% de',
			'L’arrêt d’à côté',
		])
			expect(flags(right), right).toEqual([]);
	});
});

it('uses société de transport in rider-facing notice copy', () => {
	for (const file of [
		'alerts/AlertList.svelte',
		'alerts/AlertsScreen.svelte',
		'alerts/NoticeRows.svelte',
		'alerts/alertRecord.ts',
		'health/DataHealthLive.svelte',
		'lines/LineLiveNotices.svelte',
		'lines/lineRecordText.ts',
		'record/departureDailyText.ts',
	]) {
		const raw = readFileSync(new URL(`../features/${file}`, import.meta.url), 'utf8');
		expect(raw, file).not.toMatch(/\bl['’]agence\b/iu);
	}
});
