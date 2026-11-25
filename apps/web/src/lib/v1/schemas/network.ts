import { z } from 'zod';
import {
	NetworkFileSchema as PublishedNetworkFileSchema,
	StatusDistSchema as PublishedStatusDistSchema,
} from './generated/live_network';

export { PublishedStatusDistSchema as StatusDistSchema };
const LiveStatusDistSchema = PublishedStatusDistSchema.omit({ severe: true });
export type StatusDist = z.infer<typeof LiveStatusDistSchema>;

const factTime = z.iso.datetime({ offset: true }).nullable();

export const SilentTripsSchema = z
	.array(
		z.object({
			trip_id: z.string(),
			route_id: z.string(),
			direction_id: z.int().nonnegative().nullable(),
			departure: z.object({
				service_seconds: z.int().nonnegative(),
				local_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
			}),
			silent_since: factTime,
			silent_for_seconds: z.int().nonnegative(),
		}),
	)
	.nullish();

export const LiveScheduleEvidenceSchema = z
	.object({
		captured_at: factTime,
		effective_date: z.iso.date().nullable(),
		bytes: z.int().nonnegative().nullable(),
	})
	.nullish();

export const NetworkFileSchema = PublishedNetworkFileSchema.extend({
	non_responding: PublishedNetworkFileSchema.shape.non_responding.nullable(),
	scheduled_now: PublishedNetworkFileSchema.shape.non_responding
		.nonnegative()
		.nullable()
		.optional(),
	cancelled_now: PublishedNetworkFileSchema.shape.non_responding
		.nonnegative()
		.nullable()
		.optional(),
	silent_trips: SilentTripsSchema,
	schedule: LiveScheduleEvidenceSchema,
});
export const LiveNetworkFileSchema = NetworkFileSchema.extend({
	status_dist: LiveStatusDistSchema,
});
export type NetworkFile = z.infer<typeof LiveNetworkFileSchema>;

export {
	OccupancyMixSchema,
	type OccupancyMix,
	DelayBucketSchema,
	type DelayBucket,
	NonRespondingRouteSchema,
	type NonRespondingRoute,
} from './generated/live_network';
