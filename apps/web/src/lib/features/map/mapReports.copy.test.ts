import { describe, expect, it } from 'vitest';
import { copy, mapReportsCopy } from './mapReports.copy';

describe('map reports copy', () => {
	it('carries the approved anchors in both languages', () => {
		expect(copy.en.copyLiveView).toBe('Copy link');
		expect(copy.fr.copyLiveView).toBe('Copier le lien');
		expect(copy.en.copyDisclaimer).toBe('This link opens the live view, which changes.');
		expect(copy.fr.copyDisclaimer).toBe('Ce lien ouvre la vue en direct, dont le contenu change.');
		expect(copy.en.downloadCsv).toBe('Download displayed reports (CSV)');
		expect(copy.fr.downloadCsv).toBe('Télécharger les relevés affichés (CSV)');
	});

	it('completes every visible and accessible string in both languages', () => {
		for (const locale of ['en', 'fr'] as const) {
			const t = mapReportsCopy(locale);
			for (const value of Object.values(t)) {
				expect(value.trim()).toBeTruthy();
			}
		}
	});

	it('keeps the new visible copy free of em dashes', () => {
		const all = Object.values(copy).flatMap(Object.values).join(' ');
		expect(all).not.toContain('—');
		expect(all).not.toContain('–');
	});
});
