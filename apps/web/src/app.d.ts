declare global {
	namespace App {
		interface Error {
			message: string;
			code?: 'STOP_NOT_FOUND' | 'TRIP_ENDED';
			/** The ended trip's line page, when the live feed still names its line. */
			line?: string;
		}
		interface Locals {
			locale?: 'en' | 'fr';
			approximateLocation?: import('#lib/v1/requestLocation').ApproximateLocation | null;
			overviewSchedule?: import('#lib/search/searchIndex.ts').ScheduleEdition | null;
			rankingsSchedule?: import('#lib/search/searchIndex.ts').ScheduleEdition | null;
			stopsSchedule?: import('#lib/search/searchIndex.ts').ScheduleEdition | null;
		}
		interface PageState {
			/** This history entry has the phone search sheet open. */
			searchSheet?: true;
			stopsSearch?: { href: string; data: import('#lib/server/stopListing.ts').StopSearchResult };
		}
	}
}

export {};
