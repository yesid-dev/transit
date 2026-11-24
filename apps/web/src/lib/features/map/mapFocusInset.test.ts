import { expect, it } from 'vitest';
import { measureMapFocusInset, type MapFocusMeasurementAdapter } from './mapFocusInset';

it('fits the map beside a right-aligned title when the vertical space is too short', () => {
	const container = { closest: () => ({}) } as unknown as HTMLElement;
	const adapter: MapFocusMeasurementAdapter = {
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
	const { fitPadding } = measureMapFocusInset({ getContainer: () => container }, adapter);
	expect(fitPadding).toEqual({ top: 156, right: 336, bottom: 112, left: 124 });
});
