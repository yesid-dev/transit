import { AwsClient } from "aws4fetch";

const R2_ENDPOINT = /^(?:https:\/\/)?((?:[a-z0-9-]+\.)+r2\.cloudflarestorage\.com)\/?$/i;

export function cleanDownloadStore(env) {
  const accessKeyId = env.TRANSIT1_R2_READ_ACCESS_KEY_ID;
  const secretAccessKey = env.TRANSIT1_R2_READ_SECRET_ACCESS_KEY;
  const endpoint = R2_ENDPOINT.exec(env.TRANSIT1_R2_ENDPOINT ?? "");
  if (!accessKeyId || !secretAccessKey || !endpoint) return null;

  const root = `https://${endpoint[1]}/transit-clean/`;
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto", retries: 0 });

  async function read(method, key, range) {
    const path = key.split("/").map(encodeURIComponent).join("/");
    const last = range ? range.offset + range.length - 1 : null;
    const response = await client.fetch(root + path, {
      method,
      headers: range ? { range: `bytes=${range.offset}-${last}` } : undefined,
      redirect: "error",
      cache: "no-store",
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }

    const contentLength = response.headers.get("content-length");
    const length = contentLength === null ? NaN : Number(contentLength);
    const contentRange = range && new RegExp(`^bytes ${range.offset}-${last}/([0-9]+)$`)
      .exec(response.headers.get("content-range") ?? "");
    const size = range ? Number(contentRange?.[1]) : length;
    if (response.status !== (range ? 206 : 200) || !Number.isSafeInteger(size) || size <= 0 ||
        (range && (length !== range.length || size <= last))) {
      await response.body?.cancel();
      throw new Error("Invalid response from clean R2 storage");
    }

    return { size, body: response.body, json: () => response.json() };
  }

  return {
    get: (key, options) => read("GET", key, options?.range),
    head: (key) => read("HEAD", key),
  };
}
