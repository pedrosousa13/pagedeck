import { expect, test } from "vitest";
import app from "../template-app/app/index.ts";

test("the --app starter's app sends no Strict-Transport-Security, and Hono's other defaults stay", async () => {
  for (const path of ["/api/hello", "/api/nope", "/no-such-page/"]) {
    const response = await app.request(path);
    expect(response.headers.get("Strict-Transport-Security"), path).toBeNull();
    expect(response.headers.get("X-Frame-Options"), path).toBe("SAMEORIGIN");
  }
});
