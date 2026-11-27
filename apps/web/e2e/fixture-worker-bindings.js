// These scenarios change the catalogue or timetable behind the same upstream URL.
// Requests for each scenario need their own application cache.
export const fixtureWorkerBindings = {
	alerts: 'FIXTURE_ALERTS',
	'lines-named': 'FIXTURE_LINES_NAMED',
	'record-yesterday': 'FIXTURE_RECORD_YESTERDAY',
	'schedule-isolation': 'FIXTURE_SCHEDULE_ISOLATION',
	stops: 'FIXTURE_STOPS',
	'stops-pagination': 'FIXTURE_STOPS_PAGINATION',
	'stops-volume': 'FIXTURE_STOPS_VOLUME',
};
