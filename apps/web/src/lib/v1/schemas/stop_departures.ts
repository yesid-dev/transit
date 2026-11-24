import { z } from 'zod';
import {
	StopDepartureSchema as PublishedStopDepartureSchema,
	StopDeparturesFileSchema as PublishedStopDeparturesFileSchema,
} from './generated/live_stop_departures';
import { LiveStatusCodeSchema } from './types';

export {
	PublishedStopDepartureSchema as StopDepartureSchema,
	PublishedStopDeparturesFileSchema as StopDeparturesFileSchema,
};

const LiveStopDepartureSchema = PublishedStopDepartureSchema.extend({
	status: LiveStatusCodeSchema.optional(),
});
export type StopDeparture = z.infer<typeof LiveStopDepartureSchema>;
export const LiveStopDeparturesFileSchema = PublishedStopDeparturesFileSchema.extend({
	stops: z.record(z.string(), z.array(LiveStopDepartureSchema)).optional(),
});
export type StopDeparturesFile = z.infer<typeof LiveStopDeparturesFileSchema>;
