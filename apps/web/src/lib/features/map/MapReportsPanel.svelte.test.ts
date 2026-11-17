import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { emptyFilterState } from '#lib/filters/index.ts';
import type { Vehicle, VehiclesFile } from '#lib/v1/schemas/index.ts';
import MapReportsPanel from './MapReportsPanel.svelte';
import { buildMapReportView, type MapReportView } from './mapReports';
import type { MapReportCamera } from './mapReportCamera';

const NOW = Date.parse('2026-11-16T21:00:00Z');
const camera: MapReportCamera = {
	center: [-73.6, 45.5],
	zoom: 11,
	bearing: 0,
	pitch: 0,
	width: 1000,
	height: 1000,
	bbox: { west: -74, south: 45, east: -73, north: 46 },
	project: ([lon, lat]) => ({ x: (lon + 74) * 1000, y: (46 - lat) * 1000 }),
};

function vehicle(overrides: Record<string, unknown> = {}): Vehicle {
	return {
		id: 'bus-1',
		lat: 45.5,
		lon: -73.6,
		status: 'late',
		delay_min: 3,
		updated_utc: '2026-11-16T20:59:00Z',
		reported_utc: '2026-11-16T20:58:00Z',
		trip: 'trip-1',
		route: '24',
		...overrides,
	} as unknown as Vehicle;
}

function view(
	vehicles: Vehicle[] = [vehicle()],
	health = { retained: true, failing: false, stale: false },
): MapReportView {
	const source = {
		generated_utc: '2026-11-16T20:59:40Z',
		publish_generation_id: 'gen-1',
		vehicles,
	} as unknown as VehiclesFile;
	return buildMapReportView({
		source,
		health,
		filter: emptyFilterState(),
		alertVehicleIds: new Set<string>(),
		camera,
		serverNow: NOW,
		staleCutoffS: 150,
		providerId: 'stm',
		providerName: 'STM',
		locale: 'en',
		timeZone: 'America/Toronto',
		attribution: 'Credit',
		filters: ['route:24'],
	});
}

function renderPanel(
	overrides: {
		model?: MapReportView;
		locale?: 'en' | 'fr';
		snapshotId?: string;
		copyLiveView?: () => Promise<boolean>;
		onselect?: (id: string) => void;
		onclose?: () => void;
	} = {},
) {
	const model = overrides.model ?? view();
	const props = {
		locale: overrides.locale ?? ('en' as const),
		view: model,
		providerName: 'STM',
		filterLabels: ['24'],
		line: (id: string) => `Line ${id}`,
		snapshotId: overrides.snapshotId ?? 'snapshot-1',
		liveViewHref: 'http://localhost/map?provider=stm',
		presentation: 'pane' as const,
		copyLiveView: overrides.copyLiveView ?? (async () => true),
		onselect: overrides.onselect ?? (() => {}),
		onclose: overrides.onclose,
	};
	return { ...render(MapReportsPanel, { props }), props };
}

describe('map reports panel', () => {
	it('states the scope, source time, row count and the overlapping old-position subset', () => {
		renderPanel({
			model: view([
				vehicle(),
				vehicle({ id: 'old', reported_utc: '2026-11-16T20:00:00Z' }),
				vehicle({ id: 'unlocatable', lat: 120 }),
			]),
		});
		expect(screen.getByRole('heading', { name: 'Reports in this view' })).toBeInTheDocument();
		expect(screen.getByText('STM')).toBeInTheDocument();
		expect(
			screen.getByText('Matching vehicle reports in the current map view'),
		).toBeInTheDocument();
		expect(screen.getByText('Source time')).toBeInTheDocument();
		expect(screen.getByText('America/Toronto')).toBeInTheDocument();
		expect(screen.getByText('2 reports. Of these, 1 has no recent position.')).toBeInTheDocument();
		expect(
			screen.getByText('1 matching report has no usable location and is not in this view.'),
		).toBeInTheDocument();
		expect(screen.getByText('24')).toBeInTheDocument();
	});

	it('renders each row with textual status, signed delay, report time and an operable Select', async () => {
		const onselect = vi.fn();
		renderPanel({ onselect });
		expect(screen.getByText('Late')).toBeInTheDocument();
		expect(screen.getByText('+3 min')).toBeInTheDocument();
		expect(screen.getAllByText(/Reported/u).length).toBeGreaterThan(0);
		await fireEvent.click(screen.getByRole('button', { name: 'Select vehicle bus-1' }));
		expect(onselect).toHaveBeenCalledExactlyOnceWith('bus-1');
	});

	it('offers the displayed rows as a CSV download from the captured model', () => {
		renderPanel();
		const link = screen.getByRole('link', { name: 'Download displayed reports (CSV)' });
		expect(link).toHaveAttribute('download', 'map-reports-stm-en.csv');
		expect(link.getAttribute('href')).toMatch(/^data:text\/csv;charset=utf-8,/u);
	});

	it('copies the live link and ties the confirmation to the rendered snapshot', async () => {
		const copyLiveView = vi.fn(async () => true);
		const { rerender } = renderPanel({ copyLiveView });
		await fireEvent.click(screen.getByRole('button', { name: 'Copy live view link' }));
		await waitFor(() => expect(screen.getByText('Link copied.')).toBeInTheDocument());
		expect(copyLiveView).toHaveBeenCalledOnce();
		expect(screen.getByText('This link opens the live view, which changes.')).toBeInTheDocument();

		await rerender({ ...renderPanelProps(copyLiveView), snapshotId: 'snapshot-2' });
		await waitFor(() => expect(screen.queryByText('Link copied.')).toBeNull());
	});

	it('reports a clipboard failure honestly', async () => {
		renderPanel({ copyLiveView: async () => false });
		await fireEvent.click(screen.getByRole('button', { name: 'Copy live view link' }));
		await waitFor(() =>
			expect(
				screen.getByText('Could not copy the link. Copy it from the address bar.'),
			).toBeInTheDocument(),
		);
	});

	it('shows a true empty state with a header-only export', () => {
		renderPanel({ model: view([]) });
		expect(screen.getByText('No reports match these filters.')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Download displayed reports (CSV)' })).toHaveAttribute(
			'download',
			'map-reports-stm-en.csv',
		);
	});

	it('does not reassure with a zero while loading or unavailable', () => {
		const { unmount } = renderPanel({ model: { kind: 'loading' } });
		expect(screen.getByText('Loading vehicle reports…')).toBeInTheDocument();
		expect(screen.queryByText(/^0 reports/u)).toBeNull();
		unmount();
		renderPanel({ model: { kind: 'unavailable', reason: 'view' } });
		expect(
			screen.getByText('Reports are unavailable until the map view is ready.'),
		).toBeInTheDocument();
		expect(screen.queryByText(/^0 reports/u)).toBeNull();
	});

	it('labels retained and stale source data as the last available reports', () => {
		const { unmount } = renderPanel({
			model: view([vehicle()], { retained: true, failing: true, stale: true }),
		});
		expect(
			screen.getByText('Live updates are failing. These are the last available reports.'),
		).toBeInTheDocument();
		unmount();
		renderPanel({ model: view([vehicle()], { retained: true, failing: false, stale: true }) });
		expect(
			screen.getByText(
				'The live feed has not updated recently. These are the last available reports.',
			),
		).toBeInTheDocument();
	});

	it('gives the phone overlay its own reachable Map/Reports switch', async () => {
		const oncloseSpy = vi.fn();
		render(MapReportsPanel, {
			props: {
				...renderPanelProps(async () => true),
				view: view(),
				presentation: 'overlay',
				onclose: oncloseSpy,
			},
		});
		const group = screen.getByRole('radiogroup', { name: 'Map view' });
		await fireEvent.click(withinGroup(group, 'Map'));
		expect(oncloseSpy).toHaveBeenCalledOnce();
	});

	it('translates the whole list for Québec French', () => {
		renderPanel({ locale: 'fr' });
		expect(screen.getByRole('heading', { name: 'Relevés dans cette vue' })).toBeInTheDocument();
		expect(
			screen.getByText('Relevés de véhicules correspondant à la vue actuelle de la carte'),
		).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Choisir le véhicule bus-1' })).toBeInTheDocument();
		expect(
			screen.getByRole('link', { name: 'Télécharger les relevés affichés (CSV)' }),
		).toBeInTheDocument();
	});
});

function renderPanelProps(copyLiveView: () => Promise<boolean>) {
	return {
		locale: 'en' as const,
		view: view(),
		providerName: 'STM',
		filterLabels: ['24'],
		line: (id: string) => `Line ${id}`,
		snapshotId: 'snapshot-1',
		liveViewHref: 'http://localhost/map?provider=stm',
		presentation: 'pane' as const,
		copyLiveView,
		onselect: () => {},
	};
}

function withinGroup(group: HTMLElement, name: string): HTMLElement {
	const target = [...group.querySelectorAll<HTMLElement>('[role="radio"]')].find(
		(radio) => radio.textContent?.trim() === name,
	);
	if (!target) throw new Error(`missing radio ${name}`);
	return target;
}
