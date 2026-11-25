import { WorkerEntrypoint } from "cloudflare:workers";
import { isDownloadPath, serveDownload } from "./downloads.js";
import { probeEngine, serveBoundQuestion } from "./questions.js";
import cityIds from "./.generated-public-cities.json";
import worker from "./worker.js";

const publicCities = new Set(cityIds);

export default {
  fetch(request, env, ctx) {
    return worker.fetch(request, env, ctx, publicCities);
  },
};

// Only a service binding can reach this named entrypoint.
export class Questions extends WorkerEntrypoint {
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/v2/health") {
      return probeEngine(this.env, request.signal);
    }
    if (isDownloadPath(pathname)) {
      return serveDownload(request, this.env, this.ctx, request.headers.get("x-transit-visitor-ip"));
    }
    return serveBoundQuestion(request, this.env, this.ctx, publicCities);
  }
}
