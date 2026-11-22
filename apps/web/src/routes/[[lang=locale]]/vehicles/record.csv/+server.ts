import { vehicleCsv } from '#lib/server/vehicleRecord.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url, request, params }) =>
	vehicleCsv(url, request, params.lang);
