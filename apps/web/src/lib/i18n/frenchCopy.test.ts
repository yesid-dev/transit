import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from 'svelte/compiler';
import { expect, it } from 'vitest';

// Endonyms and product names retain their official spelling in French copy.
const properNouns = ['English', 'Cloudflare Web Analytics', 'Plausible Analytics Cloud'];
const forbidden =
	/\b(?:Contains|pipeline|gate|trips?|voyages?|Slowest|BUILD|English|proxy|rollup|bus-moments|hors-norme)\b|chaîne de traitement|registre des méthodes|génération de publication|filigran[ée]|dépassement physique|transport routier|\bvers (?:est|ouest|nord|sud)\b/gi;

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

it('keeps known English labels and voyage out of French copy objects', () => {
	const root = fileURLToPath(new URL('../', import.meta.url));
	const findings: string[] = [];
	const files = readdirSync(root, { recursive: true, withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() && /\.(ts|svelte)$/.test(entry.name) && !/test|fixture/i.test(entry.name),
		)
		.map((entry) => `${entry.parentPath}/${entry.name}`)
		.sort();
	for (const file of files) {
		const path = file.slice(root.length).replaceAll('\\', '/');
		const raw = readFileSync(file, 'utf8');
		const source = file.endsWith('.svelte') ? svelteScripts(raw) : raw;
		const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		function visit(node: ts.Node, french = false) {
			if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'fr') {
				visit(node.initializer, true);
				return;
			}
			if (
				french &&
				(ts.isStringLiteralLike(node) ||
					ts.isTemplateMiddleOrTemplateTail(node) ||
					ts.isTemplateHead(node))
			) {
				if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
				// This one navigation label follows the approved French wireframe.
				const text = properNouns.reduce((value, name) => value.replaceAll(name, ''), node.text);
				const matches = text.match(forbidden);
				if (matches) findings.push(`${path}: ${matches.join(', ')} in ${node.text}`);
			}
			ts.forEachChild(node, (child) => visit(child, french));
		}
		visit(ast);
	}
	expect(files.length).toBeGreaterThan(0);
	expect(findings).toEqual([]);
});

it('uses société de transport in rider-facing notice copy', () => {
	for (const file of [
		'alerts/AlertList.svelte',
		'alerts/AlertsScreen.svelte',
		'alerts/NoticeRows.svelte',
		'lines/LineLiveNotices.svelte',
	]) {
		const raw = readFileSync(new URL(`../features/${file}`, import.meta.url), 'utf8');
		expect(raw, file).not.toMatch(/\bl['’]agence\b/iu);
	}
});
