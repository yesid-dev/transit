import { expect, test } from 'bun:test';
import { pageDrawnDividers } from './record-divider-gate';

test('rejects handwritten horizontal rules in markup, utilities and CSS', () => {
	expect(
		pageDrawnDividers(
			'<hr aria-hidden="true" />\n<div class="md:border-b-2 divide-y border-y">\n' +
				'<style>section { border-block-end: 1px solid; border-top: 1px solid; border-bottom: 1px solid; }</style>',
		),
	).toEqual([
		{ line: 1, token: '<hr' },
		{ line: 2, token: 'border-b-2' },
		{ line: 2, token: 'divide-y' },
		{ line: 2, token: 'border-y' },
		{ line: 3, token: 'border-block-end:' },
		{ line: 3, token: 'border-top:' },
		{ line: 3, token: 'border-bottom:' },
	]);
});

test('accepts kit dividers, card outlines and theme tokens', () => {
	expect(
		pageDrawnDividers(
			'<Separator variant="hand-drawn" />\n<Card class="border-border border-2" />\n' +
				'<style>aside { border: 2px solid var(--border); border-top-left-radius: 0; }</style>',
		),
	).toEqual([]);
});
