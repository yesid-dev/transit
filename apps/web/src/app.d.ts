declare global {
	namespace App {
		interface Locals {
			locale?: 'en' | 'fr';
			approximateLocation?: import('#lib/v1/requestLocation').ApproximateLocation | null;
			overviewSchedule?: import('#lib/search/searchIndex.ts').ScheduleEdition | null;
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
