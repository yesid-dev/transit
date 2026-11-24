import type { z } from 'zod';
import {
	NetworkFileSchema as PublishedNetworkFileSchema,
	StatusDistSchema as PublishedStatusDistSchema,
} from './generated/live_network';

export const StatusDistSchema = PublishedStatusDistSchema.omit({ severe: true });
export type StatusDist = z.infer<typeof StatusDistSchema>;

export const NetworkFileSchema = PublishedNetworkFileSchema.extend({
	status_dist: StatusDistSchema,
	non_responding: PublishedNetworkFileSchema.shape.non_responding.nullable(),
});
export type NetworkFile = z.infer<typeof NetworkFileSchema>;

export {
	OccupancyMixSchema,
	type OccupancyMix,
	DelayBucketSchema,
	type DelayBucket,
	NonRespondingRouteSchema,
	type NonRespondingRoute,
} from './generated/live_network';
