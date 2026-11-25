import { expect, it } from 'vitest';
import { measureMapFocusInset, type MapFocusMeasurementAdapter } from './mapFocusInset';

const container = { closest: () => ({}) } as unknown as HTMLElement;
const map = { getContainer: () => container };
const shortLandscape: MapFocusMeasurementAdapter = {
	containerRect: () => ({ top: 0, width: 844, height: 390 }) as DOMRect,
	headingRect: () => ({ bottom: 298 }) as DOMRect,
	chromeInsets: () => ({
		left: 0,
		bottom: 164,
		fitBesideHeading: { top: 140, right: 320, bottom: 96, left: 108 },
	}),
	detailOffset: () => '0px',
	rootFontSize: () => 16,
	bottomSheetHeight: () => null,
	requestFrame: () => 0,
};

it('fits the map beside a right-aligned title when the vertical space is too short', () => {
	const { fitPadding } = measureMapFocusInset(map, shortLandscape);
	expect(fitPadding).toEqual({ top: 156, right: 336, bottom: 112, left: 124 });
});

it('keeps the existing vertical fit rules when a detail sheet is open', () => {
	const { fitPadding } = measureMapFocusInset(map, {
		...shortLandscape,
		bottomSheetHeight: () => 195,
	});
	expect(fitPadding.bottom).toBeLessThan(211);
	expect(fitPadding.right).toBe(16);
});
