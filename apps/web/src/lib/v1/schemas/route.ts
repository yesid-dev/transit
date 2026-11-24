import { z } from 'zod';
import { RouteFileSchema as PublishedRouteFileSchema } from './generated/static_route';

export const RouteFileSchema = PublishedRouteFileSchema.extend({
	schedule_only: z.boolean().optional(),
});
export type RouteFile = z.infer<typeof RouteFileSchema>;

export {
	RouteStopSchema,
	type RouteStop,
	RouteDirectionSchema,
	type RouteDirection,
	ServicePeriodSchema,
	type ServicePeriod,
} from './generated/static_route';
