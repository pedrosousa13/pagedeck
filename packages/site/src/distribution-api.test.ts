import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ConfigError } from "@pagedeck/core";
import { ROUTING_VERSION } from "@pagedeck/core/routing";
import { cloudfront } from "@pagedeck/adapter-cloudfront";
import { applyDistributionConfig } from "./distribution-api.js";
import type { DistributionFragment } from "./distribution-config.js";

const RECORDED = readFileSync(new URL("./distribution-config.fixture.xml", import.meta.url), "utf8")
  .replace(/<!--[\s\S]*?-->\n/, "");

const ACCESS = { accessKey: "AKIDTEST", secretKey: "never-printed-secret" };
const ID = "E2EXAMPLE";
const CONFIG_PATH = `/2020-05-31/distribution/${ID}/config`;

const FRAGMENTS: DistributionFragment[] = cloudfront()
  .compile({
    version: ROUTING_VERSION,
    site: { trailingSlash: "never" },
    trees: [
      { redirects: [], notFound: "/404", headers: [], upstreams: [{ prefix: "/api/", url: "https://app.example.net" }] },
    ],
  })
  .artifacts.filter((artifact) => artifact.role === "distribution-config")
  .map(({ path, contents }) => ({ path, contents }));

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}

// A stand-in for CloudFront's API: SigV4 headers present and scoped to cloudfront in
// us-east-1, an ETag on every read, and an update only under a matching If-Match.
let server: Server;
let endpoint: string;
let stored: { xml: string; version: number };
let seen: Seen[];
let beforePut: () => void;

function errorBody(code: string): string {
  return `<?xml version="1.0"?><ErrorResponse xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"><Error><Type>Sender</Type><Code>${code}</Code><Message>${code} for AKIDTEST</Message></Error><RequestId>r</RequestId></ErrorResponse>`;
}

beforeEach(async () => {
  stored = { xml: RECORDED, version: 1 };
  seen = [];
  beforePut = () => {};
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
      const reply = (status: number, text: string, headers: Record<string, string> = {}): void => {
        response.writeHead(status, { "content-type": "text/xml", ...headers });
        response.end(text);
      };
      const auth = request.headers.authorization ?? "";
      if (
        !/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/cloudfront\/aws4_request, SignedHeaders=[a-z;-]*host[a-z;-]*, Signature=[0-9a-f]{64}$/.test(auth) ||
        request.headers["x-amz-date"] === undefined
      ) {
        reply(403, errorBody("AccessDenied"));
        return;
      }
      if (request.url !== CONFIG_PATH) {
        reply(404, errorBody("NoSuchDistribution"));
        return;
      }
      if (request.method === "GET") {
        reply(200, stored.xml, { etag: `E${String(stored.version)}` });
        return;
      }
      if (request.method === "PUT") {
        beforePut();
        const match = request.headers["if-match"];
        if (match === undefined) {
          reply(400, errorBody("InvalidIfMatchVersion"));
          return;
        }
        if (match !== `E${String(stored.version)}`) {
          reply(412, errorBody("PreconditionFailed"));
          return;
        }
        stored = { xml: body, version: stored.version + 1 };
        reply(200, "<Distribution/>", { etag: `E${String(stored.version)}` });
        return;
      }
      reply(405, errorBody("MethodNotAllowed"));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

async function run(apply: boolean, distributionId = ID): Promise<string[]> {
  const lines: string[] = [];
  await applyDistributionConfig({
    endpoint,
    access: ACCESS,
    distributionId,
    fragments: FRAGMENTS,
    apply,
    write: (line) => lines.push(line),
  });
  return lines;
}

test("a dry run reads the config, prints the merged config, and sends no update", async () => {
  const lines = await run(false);
  expect(seen.map(({ method }) => method)).toEqual(["GET"]);
  expect(stored.xml).toBe(RECORDED);
  const printed = lines.join("\n");
  expect(printed).toContain("Distribution E2EXAMPLE: 1 Pagedeck origin, 2 Pagedeck cache behaviors");
  expect(printed).toContain("<PathPattern>/api/*</PathPattern>");
  expect(printed).toContain("<Quantity>3</Quantity>");
  expect(lines.at(-1)).toBe("Dry run: distribution E2EXAMPLE is not updated. Pass --apply to send this config.");
});

test("applying twice updates once, under the ETag it read, and the second run sends nothing", async () => {
  await run(true);
  expect(seen.map(({ method }) => method)).toEqual(["GET", "PUT"]);
  expect(seen[1]?.headers["if-match"]).toBe("E1");
  expect(stored.version).toBe(2);
  expect(stored.xml).toContain("<PathPattern>/api/*</PathPattern>");

  const second = await run(true);
  expect(seen.map(({ method }) => method)).toEqual(["GET", "PUT", "GET"]);
  expect(stored.version).toBe(2);
  expect(second).toEqual(["Distribution E2EXAMPLE: unchanged — its config already holds these fragments."]);
});

test("a config changed between the read and the update is refused, not overwritten", async () => {
  beforePut = () => {
    stored = { ...stored, version: stored.version + 1 };
  };
  const failure = run(true);
  await expect(failure).rejects.toBeInstanceOf(ConfigError);
  await expect(failure).rejects.toThrow(
    "Distribution E2EXAMPLE: UpdateDistribution answered 412 PreconditionFailed — the config changed after this deploy read it at ETag E1; run the deploy again, which reads it afresh",
  );
});

test("an unknown distribution is named, and no credential reaches the message", async () => {
  const failure = run(false, "ENOPE");
  await expect(failure).rejects.toThrow(
    "Distribution ENOPE: GetDistributionConfig answered 404 NoSuchDistribution — check the distribution id",
  );
  const message = await failure.catch((error: unknown) => (error as Error).message);
  expect(message).not.toContain(ACCESS.secretKey);
  expect(message).not.toContain(ACCESS.accessKey);
});
