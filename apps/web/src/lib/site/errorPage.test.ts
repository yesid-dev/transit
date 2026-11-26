import { describe, expect, it } from 'vitest';
import { errorDocumentHead, errorPageCopy } from './errorPage';

describe('error page shared copy', () => {
	it('builds the exact 404 head in both locales', () => {
		expect(errorDocumentHead(404, 'en')).toEqual({
			title: '404 · This page does not exist',
			description: 'Check the address, or open one of these pages.',
		});
		expect(errorDocumentHead(404, 'fr')).toEqual({
			title: '404 · Cette page n’existe pas',
			description: 'Vérifiez l’adresse ou ouvrez l’une de ces pages.',
		});
	});

	it('keeps Transit destinations centralized for the rendered page', () => {
		expect(errorPageCopy.en.notFound.suggestions.map(({ href }) => href)).toEqual([
			'/',
			'/search',
			'/lines',
			'/stops',
			'/network',
		]);
		expect(errorPageCopy.fr.notFound.suggestions.map(({ href }) => href)).toEqual(
			errorPageCopy.en.notFound.suggestions.map(({ href }) => href),
		);
	});

	it('uses the generic error heading for non-404 statuses', () => {
		expect(errorDocumentHead(500, 'en').title).toBe('500 · Something went wrong');
	});
});
