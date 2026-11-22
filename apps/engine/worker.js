import { Container } from "@cloudflare/containers";

const runtimeKeys = [
  "ENGINE_CLEAN_ROOT",
  "ENGINE_S3_ENDPOINT",
  "ENGINE_CLEANING_VERSION",
  "ENGINE_CONCURRENCY",
  "ENGINE_QUERY_THREADS",
  "ENGINE_QUERY_MEMORY_MIB",
  "ENGINE_QUEUE_SIZE",
  "ENGINE_QUEUE_WAIT_MS",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

export class TransitEngine extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  pingEndpoint = "ping/healthz";

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = Object.fromEntries(
      runtimeKeys.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
    );
  }
}

export default {
  fetch(request, env) {
    return env.ENGINE.getByName("network").fetch(request);
  },
};
