const R2_ENDPOINT = /^(?:https:\/\/)?((?:[a-z0-9-]+\.)+r2\.cloudflarestorage\.com)\/?$/i;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SIGNING_ALGORITHM = "AWS4-HMAC-SHA256";
const encoder = new TextEncoder();

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
}

// Sign a bodyless S3 request with a fixed service and region. R2 paths have no query.
async function signedHeaders(url, method, range, accessKeyId, secretAccessKey) {
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = timestamp.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const headers = new Headers({
    "x-amz-content-sha256": EMPTY_SHA256,
    "x-amz-date": timestamp,
  });
  if (range) headers.set("range", range);

  // Headers iterates in lexical order. Host is signed using the URL's outgoing host.
  const canonicalHeaders = [["host", url.host], ...headers];
  const names = canonicalHeaders.map(([name]) => name).join(";");
  const request = [
    method, url.pathname, "", ...canonicalHeaders.map(([name, value]) => `${name}:${value}`),
    "", names, EMPTY_SHA256,
  ].join("\n");
  const digest = hex(await crypto.subtle.digest("SHA-256", encoder.encode(request)));
  const toSign = [SIGNING_ALGORITHM, timestamp, scope, digest].join("\n");
  const dateKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`), day);
  const regionKey = await hmac(dateKey, "auto");
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, toSign));
  headers.set("authorization",
    `${SIGNING_ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${signature}`,
  );
  return headers;
}

export function cleanDownloadStore(env) {
  const accessKeyId = env.TRANSIT1_R2_READ_ACCESS_KEY_ID;
  const secretAccessKey = env.TRANSIT1_R2_READ_SECRET_ACCESS_KEY;
  const endpoint = R2_ENDPOINT.exec(env.TRANSIT1_R2_ENDPOINT ?? "");
  if (!accessKeyId || !secretAccessKey || !endpoint) return null;

  const root = `https://${endpoint[1]}/transit-clean/`;

  async function read(method, key, range) {
    const path = key.split("/").map(encodeURIComponent).join("/");
    const last = range ? range.offset + range.length - 1 : null;
    const url = new URL(root + path);
    const rangeHeader = range ? `bytes=${range.offset}-${last}` : undefined;
    const response = await fetch(url, {
      method,
      headers: await signedHeaders(url, method, rangeHeader, accessKeyId, secretAccessKey),
      // Workers supports manual redirects. The status check below rejects any redirect.
      redirect: "manual",
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

    return { size, etag: response.headers.get("etag"), body: response.body, json: () => response.json() };
  }

  return {
    get: (key, options) => read("GET", key, options?.range),
    head: (key) => read("HEAD", key),
  };
}
