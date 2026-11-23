import { WorkerEntrypoint } from "cloudflare:workers";
import { probeEngine, serveBoundQuestion } from "./questions.js";

export { default } from "./worker.js";

// Only a service binding can reach this named entrypoint.
export class Questions extends WorkerEntrypoint {
  fetch(request) {
    if (request.method === "GET" && new URL(request.url).pathname === "/v2/health") {
      return probeEngine(this.env, request.signal);
    }
    return serveBoundQuestion(request, this.env, this.ctx);
  }
}
