import { describe, expect, it } from 'vitest';
import { copy, mapReportsCopy } from './mapReports.copy';

describe('map reports copy', () => {
	it('carries the approved anchors in both languages', () => {
		expect(copy.en.reportsTitle).toBe('Reports in this view');
		expect(copy.fr.reportsTitle).toBe('Relevés dans cette vue');
		expect(copy.en.copyLiveView).toBe('Copy live view link');
		expect(copy.fr.copyLiveView).toBe('Copier le lien de la vue en direct');
		expect(copy.en.copyDisclaimer).toBe('This link opens the live view, which changes.');
		expect(copy.fr.copyDisclaimer).toBe('Ce lien ouvre la vue en direct, dont le contenu change.');
		expect(copy.en.downloadCsv).toBe('Download displayed reports (CSV)');
		expect(copy.fr.downloadCsv).toBe('Télécharger les relevés affichés (CSV)');
		expect(copy.en.reportsEmpty).toBe('No reports match these filters.');
		expect(copy.fr.reportsEmpty).toBe('Aucun relevé ne correspond à ces filtres.');
	});

	it('states the report count and the overlapping old-position subset', () => {
		expect(copy.en.reportsCount('12', '3', 12, 3)).toBe(
			'12 reports. Of these, 3 have no recent position.',
		);
		expect(copy.fr.reportsCount('12', '3', 12, 3)).toBe(
			'12 relevés. Parmi ceux-ci, 3 n’ont pas de position récente.',
		);
		expect(copy.en.reportsCount('1', '1', 1, 1)).toBe(
			'1 report. Of these, 1 has no recent position.',
		);
		expect(copy.fr.reportsCount('0', '0', 0, 0)).toBe(
			'0 relevé. Parmi ceux-ci, 0 n’a pas de position récente.',
		);
	});

	it('completes every visible and accessible string in both languages', () => {
		for (const locale of ['en', 'fr'] as const) {
			const t = mapReportsCopy(locale);
			for (const value of [
				t.viewSwitchLabel,
				t.mapTab,
				t.reportsTab,
				t.reportsTitle,
				t.reportsScope,
				t.reportsEmpty,
				t.copyLiveView,
				t.copyDisclaimer,
				t.downloadCsv,
				t.copied,
				t.copyFailed,
				t.loading,
				t.unavailableView,
				t.unavailableSource,
				t.unavailableClock,
				t.retainedWarning,
				t.staleWarning,
				t.sourceTime,
				t.timeZone,
				t.reportAge,
				t.statusColumn,
				t.delayColumn,
				t.lineUnknown,
			]) {
				expect(value.trim()).toBeTruthy();
			}
			expect(t.reportedAt('19:21')).toMatch(/19:21/u);
			expect(t.sourceUpdatedAt('19:21')).toMatch(/19:21/u);
			expect(t.selectVehicle('bus-1')).toMatch(/bus-1/u);
			expect(t.unscoped('2', 2)).toMatch(/2/u);
		}
	});

	it('keeps the new visible copy free of em dashes', () => {
		const all = [copy.en, copy.fr]
			.flatMap((t) => [
				t.reportsTitle,
				t.reportsScope,
				t.copyDisclaimer,
				t.retainedWarning,
				t.staleWarning,
				t.reportsEmpty,
			])
			.join(' ');
		expect(all).not.toContain('—');
		expect(all).not.toContain('–');
	});
});
