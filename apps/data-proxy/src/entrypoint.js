import { WorkerEntrypoint } from "cloudflare:workers";
import { serveBoundQuestion } from "./questions.js";

export { default } from "./worker.js";

// Only a service binding can reach this named entrypoint.
export class Questions extends WorkerEntrypoint {
  fetch(request) {
    return serveBoundQuestion(request, this.env, this.ctx);
  }
}
