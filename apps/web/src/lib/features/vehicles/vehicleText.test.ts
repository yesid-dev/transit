import { expect, it } from 'vitest';
import {
	assignmentCaution,
	notTracked,
	vehicleHeadline,
	vehicleRecordState,
} from './vehicleText.ts';

it('leads with the published status even when the numerical offset is behind schedule', () => {
	const vehicle = { status: 'on_time', delay_min: 4 } as const;
	expect(vehicleHeadline(vehicle, 'en')).toBe('On time, 4 min behind the timetable');
	expect(vehicleHeadline(vehicle, 'fr')).toBe('À l’heure, 4 min après l’heure prévue');
	expect(vehicleHeadline({ status: 'late', delay_min: null }, 'en')).toBe('Late');
});

it.each([
	['not_measured', 'Non mesuré'],
	['too_few_to_judge', 'Trop peu pour juger'],
	['unknown', 'Inconnu'],
])('keeps the engine’s %s explanation', (state, text) => {
	expect(vehicleRecordState(state, text, 'fr')).toBe(text);
});

it('explains the tracking limit and the influence of assignments in both languages', () => {
	expect(vehicleRecordState('not_tracked', '', 'en')).toContain('stable vehicle numbers');
	expect(notTracked.fr).toContain('numéros de véhicule stables');
	expect(assignmentCaution.en).toContain('lines and hours it is assigned to');
	expect(assignmentCaution.fr).toContain('lignes et les heures qu’on lui confie');
});
