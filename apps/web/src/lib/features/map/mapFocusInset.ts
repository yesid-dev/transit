import type { Map as MapLibreMap } from 'maplibre-gl';
import { tick } from 'svelte';
import { coveredArea } from './mapCameraCoveredArea';

export const MIN_VISIBLE_SPAN_PX = 240;

interface MapChromeInsets {
	left: number;
	bottom: number;
	fitTop?: number;
	fitLeft?: number;
	fitBesideNorth?: { right: number; bottom: number };
	fitBesideHeading?: { top: number; right: number; bottom: number; left: number };
}

export interface MapFocusMeasurementAdapter {
	containerRect(container: HTMLElement): DOMRect;
	chromeInsets?(container: HTMLElement): MapChromeInsets;
	headingRect(hero: Element): DOMRect | null;
	detailOffset(hero: Element): string;
	rootFontSize(): number;
	bottomSheetHeight(): number | null;
	requestFrame(callback: FrameRequestCallback): number;
}

export interface MapFocusInset {
	fitPadding: { top: number; right: number; bottom: number; left: number };
	containerWidth: number;
	containerHeight: number;
	topOcclusion: number;
	rightOcclusion: number;
	bottomOcclusion: number;
	pointOffset: [number, number];
	routePadding: { top: number; right: number; bottom: number; left: number };
}

type FocusMap = Pick<MapLibreMap, 'getContainer'>;

const DOM_MEASUREMENT: MapFocusMeasurementAdapter = {
	chromeInsets: (container) => {
		const box = container.getBoundingClientRect();
		const hero = container.closest('.map-hero');
		const rect = (selector: string) => {
			const el = hero?.querySelector(selector);
			const r = el?.getBoundingClientRect();
			return r && r.width > 0 && r.height > 0 ? r : null;
		};
		const frame = hero?.closest('[data-slot="app-frame"]');
		const pairedControls = frame
			?.querySelector('[data-frame-controls="desktop"]')
			?.getBoundingClientRect();
		const panel = pairedControls?.width ? pairedControls : null;
		const north = rect('[data-slot="map-north"]');
		const heading = rect('.map-head');
		const wide = hero?.getAttribute('data-map-wide') === 'true';
		const cameraActions = hero?.querySelector('.map-camera-actions');
		const actions = rect('.map-camera-actions');
		const attribution = rect('.maplibregl-ctrl-attrib');
		const landscapeDock =
			!wide && cameraActions && getComputedStyle(cameraActions).gridAutoFlow === 'column';
		const headingOnRight = heading && heading.left > box.left + box.width / 2;
		const header = frame?.querySelector('[data-slot="app-frame-chrome"]')?.getBoundingClientRect();
		const framePill = frame
			?.querySelector('[data-slot="surface-rail-mobile"]')
			?.getBoundingClientRect();
		const credit = frame?.querySelector('[data-slot="map-source-footer"]')?.getBoundingClientRect();
		const legendButton = rect('[data-slot="map-legend-fab"]');
		const fitTop =
			wide && header
				? header.bottom
				: !landscapeDock && heading && actions
					? Math.max(heading.bottom, actions.bottom)
					: undefined;
		return {
			left: panel ? panel.right - box.left : 0,
			// The narrow controls rail leaves the provider framing viewport-centered.
			// Point and route focus still clear its actual covered edge.
			fitLeft: panel && panel.width > 56 ? panel.right - box.left : 0,
			fitTop: fitTop === undefined ? undefined : Math.max(0, fitTop - box.top),
			bottom: Math.max(
				0,
				...(wide ? [actions, attribution] : [north, attribution, legendButton]).map((r) =>
					r ? box.bottom - r.top : 0,
				),
			),
			fitBesideNorth:
				north && !landscapeDock ? { right: box.right - north.left, bottom: 0 } : undefined,
			fitBesideHeading:
				heading && header && (headingOnRight || landscapeDock)
					? {
							top: Math.max(0, header.bottom - box.top),
							right: Math.max(
								headingOnRight ? box.right - heading.left : 0,
								...(landscapeDock
									? [north, rect('.map-camera-actions'), rect('.map-in-view-button')].map((r) =>
											r ? box.right - r.left : 0,
										)
									: []),
							),
							bottom: Math.max(
								0,
								...[framePill, credit].map((r) => (r?.height ? box.bottom - r.top : 0)),
							),
							left: Math.max(
								0,
								(legendButton?.right ?? box.left) - box.left,
								headingOnRight ? 0 : heading.right - box.left,
							),
						}
					: undefined,
		};
	},
	containerRect: (container) => container.getBoundingClientRect(),
	headingRect: (hero) => hero.querySelector('.map-head')?.getBoundingClientRect() ?? null,
	detailOffset: (hero) => {
		const panel = hero.querySelector(
			'.map-hero[data-map-wide="true"] [data-slot="map-details"], [data-slot="map-detail-overlay"]',
		);
		return panel
			? Math.max(0, hero.getBoundingClientRect().right - panel.getBoundingClientRect().left) + 'px'
			: getComputedStyle(hero).getPropertyValue('--map-detail-offset');
	},
	rootFontSize: () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
	bottomSheetHeight: () => {
		const sheet = document.querySelector(
			'[data-slot="bottom-sheet"][data-state="open"]:not([data-map-sheet-mode="in-view"])',
		);
		return sheet ? sheet.getBoundingClientRect().height : null;
	},
	requestFrame: (callback) => requestAnimationFrame(callback),
};

let latestIntentToken = 0;

function clampOcclusion(raw: number, containerSpan: number): number {
	const finiteRaw = Number.isFinite(raw) ? raw : 0;
	return Math.min(Math.max(finiteRaw, 0), Math.max(0, containerSpan - MIN_VISIBLE_SPAN_PX));
}

function parseDetailOffset(value: string, rootFontSize: number): number {
	const match = value.trim().match(/^(-?(?:\d+\.?\d*|\.\d+))(px|rem)$/u);
	if (!match) return 0;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount)) return 0;
	return match[2] === 'rem' ? amount * rootFontSize : amount;
}

export function measureMapFocusInset(
	map: FocusMap,
	adapter: MapFocusMeasurementAdapter = DOM_MEASUREMENT,
): MapFocusInset {
	const container = map.getContainer();
	const containerRect = adapter.containerRect(container);
	const containerWidth = Math.max(0, containerRect.width);
	const containerHeight = Math.max(0, containerRect.height);
	const hero = container.closest('.map-hero');
	const heading = hero ? adapter.headingRect(hero) : null;
	const rawTop = Math.max(0, heading ? heading.bottom - containerRect.top : 0);
	const topOcclusion = clampOcclusion(rawTop, containerHeight);
	const rawRight = hero ? parseDetailOffset(adapter.detailOffset(hero), adapter.rootFontSize()) : 0;
	const measuredSheetHeight = adapter.bottomSheetHeight();
	const chrome = adapter.chromeInsets?.(container) ?? { left: 0, bottom: 0 };
	const rawBottom =
		measuredSheetHeight === null
			? 0
			: measuredSheetHeight === 0
				? containerHeight * 0.5
				: measuredSheetHeight;
	const rightOcclusion = clampOcclusion(rawRight, containerWidth);
	const bottomOcclusion = clampOcclusion(rawBottom, containerHeight - topOcclusion);
	let fitBottom = Math.max(0, rawBottom, chrome.bottom);
	let fitLeft = Math.max(0, chrome.fitLeft ?? chrome.left);
	let fitRight = Math.max(0, rawRight);
	// In landscape, the north control can exhaust the vertical fit budget from one
	// corner. Fit beside it when that leaves enough height to clear the map heading.
	const beside = chrome.fitBesideNorth;
	if (beside && rawTop + fitBottom + 32 >= containerHeight) {
		const bottom = Math.max(0, rawBottom, beside.bottom);
		const right = Math.max(fitRight, beside.right);
		if (rawTop + bottom + 32 < containerHeight && fitLeft + right + 32 < containerWidth) {
			fitBottom = bottom;
			fitRight = right;
		}
	}
	// Keep actual chrome clearance whenever the fit has room for both 16px margins.
	// Only overfull axes need the point-focus budget to keep geographic fitting valid.
	let fitTop = chrome.fitTop ?? rawTop;
	// Short landscape viewports can fit to the left of a right-aligned title card.
	const besideHeading = chrome.fitBesideHeading;
	if (measuredSheetHeight === null && besideHeading && fitTop + fitBottom + 32 >= containerHeight) {
		const right = Math.max(fitRight, besideHeading.right);
		const left = Math.max(fitLeft, besideHeading.left);
		const bottom = Math.max(0, rawBottom, besideHeading.bottom);
		if (besideHeading.top + bottom + 32 < containerHeight && left + right + 32 < containerWidth) {
			fitTop = besideHeading.top;
			fitRight = right;
			fitLeft = left;
			fitBottom = bottom;
		}
	}
	const verticalFit = fitTop + fitBottom + 32 < containerHeight;
	const horizontalFit = fitLeft + fitRight + 32 < containerWidth;

	const { pointOffset, routePadding } = coveredArea(
		{
			top: topOcclusion,
			right: rightOcclusion,
			bottom: bottomOcclusion,
			left: clampOcclusion(chrome.left, containerWidth - rightOcclusion),
		},
		64,
	);
	return {
		fitPadding: coveredArea(
			{
				top: verticalFit ? fitTop : topOcclusion,
				right: horizontalFit ? fitRight : rightOcclusion,
				bottom: verticalFit ? fitBottom : clampOcclusion(fitBottom, containerHeight - topOcclusion),
				left: horizontalFit ? fitLeft : clampOcclusion(fitLeft, containerWidth - rightOcclusion),
			},
			16,
		).routePadding,
		containerWidth,
		containerHeight,
		topOcclusion,
		rightOcclusion,
		bottomOcclusion,
		pointOffset,
		routePadding,
	};
}

export function deferMapFocusInset(
	map: FocusMap,
	consume: (inset: MapFocusInset) => void,
	adapter: MapFocusMeasurementAdapter = DOM_MEASUREMENT,
): void {
	const intentToken = ++latestIntentToken;
	const container = map.getContainer();
	void (async () => {
		await tick();
		await new Promise<void>((resolve) => adapter.requestFrame(() => resolve()));
		if (intentToken !== latestIntentToken) return;
		if (!container.isConnected) return;
		consume(measureMapFocusInset({ getContainer: () => container }, adapter));
	})();
}
