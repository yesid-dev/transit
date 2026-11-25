import { render, screen, within } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import { ManifestSchema } from '#lib/v1/schemas/index.ts';
import { overviewCopy } from './overviewRecord.copy';
import OverviewLiveCard from './OverviewLiveCard.svelte';

const { createLiveStore } = vi.hoisted(() => ({ createLiveStore: vi.fn() }));
vi.mock('#lib/v1/live/store.svelte.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/v1/live/store.svelte.ts')>()),
	createLiveStore,
}));

const generated = '2026-11-25T04:05:00Z';
const manifest = ManifestSchema.parse({
	provider: 'fixture-network',
	display_name: 'Fixture network',
	bbox: [],
	attribution: '',
	dataset_version: 'demo',
	labels: {},
	surfaces: [],
	capabilities: { live_map: 'enabled' },
	files: { live: { generated_utc: generated, ttl_s: 30 } },
});

function renderLive(
	locale: 'en' | 'fr',
	counts: { non_responding: number | null; scheduled_now?: number },
) {
	const family = { phase: 'ready', health: { state: 'live', retained: true } };
	createLiveStore.mockReturnValue({
		start: vi.fn(),
		stop: vi.fn(),
		familyStates: { network: family, alerts: family },
		network: {
			generated_utc: generated,
			vehicles_in_service: 5,
			status_dist: { early: 1, on_time: 1, late: 3, unknown: 0 },
			...counts,
		},
		vehicles: {
			vehicles: [
				{ route: '51', status: 'late' },
				{ route: '24', status: 'late' },
				{ route: '51', status: 'on_time' },
				{ route: '51', status: 'late' },
				{ route: '90', status: 'early' },
			],
		},
	});
	render(OverviewLiveCard, {
		props: { locale, manifest, alertsAvailable: false, link: (path) => path },
	});
	return within(screen.getByText(overviewCopy[locale].silent).parentElement!);
}

it.each([
	['en', 'of 1,306 trips scheduled now', '2 of 3 vehicles'],
	['fr', /^sur 1\s?306 trajets prévus en ce moment$/u, '2 sur 3 véhicules'],
] as const)('renders the localized silent trips and late lines in %s', (locale, detail, ratio) => {
	const row = renderLive(locale, { non_responding: 44, scheduled_now: 1306 });
	expect(row.getByText('44')).toBeVisible();
	expect(row.getByText(detail)).toHaveClass('text-muted-foreground');
	expect(screen.getByRole('heading', { name: overviewCopy[locale].lateLines })).toBeVisible();
	const first = screen.getAllByRole('listitem')[0];
	expect(within(first).getByRole('link')).toHaveAttribute('href', '/lines/51');
	expect(within(first).getByText(ratio)).toBeVisible();
	expect(screen.getAllByRole('listitem')).toHaveLength(2);
});

it.each([
	['en', 'Not measured', { non_responding: null }],
	['fr', 'Non mesuré', { non_responding: 44 }],
] as const)(
	'keeps the absence state when the pair is incomplete in %s',
	(locale, missing, counts) => {
		const row = renderLive(locale, counts);
		expect(row.getByText(missing)).toBeVisible();
	},
);
