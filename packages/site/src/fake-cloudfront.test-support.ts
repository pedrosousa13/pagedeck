import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export const RECORDED = readFileSync(new URL("./distribution-config.fixture.xml", import.meta.url), "utf8")
  .replace(/<!--[\s\S]*?-->\n/, "");

export const ACCESS = { accessKey: "AKIDTEST", secretKey: "never-printed-secret" };

export interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}

export interface FakeCloudFront {
  endpoint: string;
  stored: Map<string, { xml: string; version: number }>;
  seen: Seen[];
  beforePut: () => void;
  close(): Promise<void>;
}

function errorBody(code: string): string {
  return `<?xml version="1.0"?><ErrorResponse xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"><Error><Type>Sender</Type><Code>${code}</Code><Message>${code} for AKIDTEST</Message></Error><RequestId>r</RequestId></ErrorResponse>`;
}

// A stand-in for CloudFront's API: SigV4 headers present and scoped to cloudfront in
// us-east-1, an ETag on every read, and an update only under a matching If-Match. Each id
// in `ids` starts with the recorded config.
export async function startFakeCloudFront(ids: readonly string[]): Promise<FakeCloudFront> {
  const fake: Omit<FakeCloudFront, "endpoint" | "close"> = {
    stored: new Map(ids.map((id) => [id, { xml: RECORDED, version: 1 }])),
    seen: [],
    beforePut: () => {},
  };
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      fake.seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
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
      const id = /^\/2020-05-31\/distribution\/([^/]+)\/config$/.exec(request.url ?? "")?.[1];
      const stored = id === undefined ? undefined : fake.stored.get(id);
      if (id === undefined || stored === undefined) {
        reply(404, errorBody("NoSuchDistribution"));
        return;
      }
      if (request.method === "GET") {
        reply(200, stored.xml, { etag: `E${String(stored.version)}` });
        return;
      }
      if (request.method === "PUT") {
        fake.beforePut();
        const current = fake.stored.get(id) ?? stored;
        const match = request.headers["if-match"];
        if (match === undefined) {
          reply(400, errorBody("InvalidIfMatchVersion"));
          return;
        }
        if (match !== `E${String(current.version)}`) {
          reply(412, errorBody("PreconditionFailed"));
          return;
        }
        fake.stored.set(id, { xml: body, version: current.version + 1 });
        reply(200, "<Distribution/>", { etag: `E${String(current.version + 1)}` });
        return;
      }
      reply(405, errorBody("MethodNotAllowed"));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return Object.assign(fake, {
    endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  });
}
