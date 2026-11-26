import { render } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import MapFrameLegend from './MapFrameLegend.svelte';

it.each([
	['en', true, /Rail: schedule only/],
	['fr', true, /horaire seulement/],
	['en', false, null],
	['fr', false, null],
] as const)('%s legend with schedule-only lines %s', (locale, scheduleOnlyLines, rail) => {
	const { container } = render(MapFrameLegend, {
		props: { locale, layer: 'live', colourBy: 'status', staleCutoffS: 600, scheduleOnlyLines },
	});
	const text = container.textContent ?? '';
	if (rail) expect(text).toMatch(rail);
	else expect(text).not.toMatch(/Rail|horaire seulement/);
	expect(text).toMatch(locale === 'fr' ? /Sélection/ : /Selected/);
});
