import { z } from 'zod';
import {
	StopDepartureSchema as PublishedStopDepartureSchema,
	StopDeparturesFileSchema as PublishedStopDeparturesFileSchema,
} from './generated/live_stop_departures';
import { StatusCodeSchema } from './types';

export const StopDepartureSchema = PublishedStopDepartureSchema.extend({
	status: StatusCodeSchema.optional(),
});
export type StopDeparture = z.infer<typeof StopDepartureSchema>;
export const StopDeparturesFileSchema = PublishedStopDeparturesFileSchema.extend({
	stops: z.record(z.string(), z.array(StopDepartureSchema)).optional(),
});
export type StopDeparturesFile = z.infer<typeof StopDeparturesFileSchema>;
