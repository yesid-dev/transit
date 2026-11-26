import { render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorPage from './+error.svelte';

const pageState = vi.hoisted(() => ({
	value: {
		status: 404,
		error: null as { message?: string; code?: 'STOP_NOT_FOUND' } | null,
		url: new URL('https://transit.yesid.dev/missing'),
	},
}));

vi.mock('$app/state', () => ({
	get page() {
		return pageState.value;
	},
}));

beforeEach(() => {
	pageState.value = {
		status: 404,
		error: null,
		url: new URL('https://transit.yesid.dev/missing'),
	};
});

describe('error route', () => {
	it('renders the approved construction composition with Transit destinations for a 404', () => {
		const { container } = render(ErrorPage);

		expect(screen.getByTestId('hazard-tape')).toBeInTheDocument();
		expect(screen.getByTestId('construction-scene')).toBeInTheDocument();
		expect(screen.queryByTestId('error-label')).not.toBeInTheDocument();
		expect(
			screen.getByRole('heading', { level: 1, name: 'This page does not exist' }),
		).toBeInTheDocument();
		expect(screen.getByRole('link', { name: /Overview/ })).toHaveAttribute('href', '/');
		expect(screen.getByRole('link', { name: /Search/ })).toHaveAttribute('href', '/search');
		expect(screen.getByRole('link', { name: /Lines/ })).toHaveAttribute('href', '/lines');
		expect(screen.getByRole('link', { name: /Stops/ })).toHaveAttribute('href', '/stops');
		expect(screen.getByRole('link', { name: /Network health/ })).toHaveAttribute(
			'href',
			'/network',
		);
		expect(screen.getByTestId('terminal-line')).toHaveTextContent('route --status 404');
		expect(container.querySelectorAll('[data-testid="hazard-tape"]')).toHaveLength(1);
		expect(document.title).toBe('404 · This page does not exist · Transit');
		// The layout owns robots; the built-page spec verifies the single noindex tag.
		expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
	});

	it('localizes the 404 copy and all Transit destination paths in French', () => {
		pageState.value = {
			status: 404,
			error: null,
			url: new URL('https://transit.yesid.dev/fr/introuvable'),
		};

		render(ErrorPage);

		expect(
			screen.getByRole('heading', { level: 1, name: 'Cette page n’existe pas' }),
		).toBeInTheDocument();
		expect(screen.getByRole('link', { name: /Aperçu/ })).toHaveAttribute('href', '/fr');
		expect(screen.getByRole('link', { name: /Recherche/ })).toHaveAttribute('href', '/fr/search');
		expect(screen.getByRole('link', { name: /Lignes/ })).toHaveAttribute('href', '/fr/lines');
		expect(screen.getByRole('link', { name: /Arrêts/ })).toHaveAttribute('href', '/fr/stops');
		expect(screen.getByRole('link', { name: /Santé du réseau/ })).toHaveAttribute(
			'href',
			'/fr/network',
		);
	});

	it.each([
		['en', '/stop/57135', 'This stop could not be found', 'Find a stop', '/stops'],
		['fr', '/fr/stop/57135', 'Cet arrêt est introuvable', 'Trouver un arrêt', '/fr/stops'],
	] as const)('says plainly in %s that a stop is missing', (_locale, path, heading, find, href) => {
		pageState.value = {
			status: 404,
			error: { code: 'STOP_NOT_FOUND', message: heading + '.' },
			url: new URL(path, 'https://transit.yesid.dev'),
		};

		render(ErrorPage);

		expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: find })).toHaveAttribute('href', href);
		expect(screen.queryByTestId('construction-scene')).not.toBeInTheDocument();
		expect(screen.queryByTestId('error-label')).not.toBeInTheDocument();
		expect(screen.queryByTestId('terminal-line')).not.toBeInTheDocument();
		expect(document.title).toBe(`404 · ${heading} · Transit`);
	});

	it('preserves the generic error treatment and never presents a 500 as a 404 construction sign', () => {
		pageState.value = {
			status: 500,
			error: { message: 'Database unavailable' },
			url: new URL('https://transit.yesid.dev/network'),
		};

		render(ErrorPage);

		expect(
			screen.getByRole('heading', { level: 1, name: 'Something went wrong' }),
		).toBeInTheDocument();
		expect(screen.getByText('Database unavailable')).toBeInTheDocument();
		expect(screen.getByRole('alert')).toHaveTextContent('500');
		expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
		expect(screen.getByTestId('construction-scene')).not.toHaveTextContent('500');
		expect(screen.queryByTestId('terminal-line')).not.toBeInTheDocument();
	});
});
