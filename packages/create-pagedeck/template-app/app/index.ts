import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { validator } from "hono/validator";

// Before `basePath`, so a host that hands the app a path with no file still sends these headers.
const app = new Hono()
  .use(secureHeaders({ strictTransportSecurity: false }))
  .use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  })
  .basePath("/api")
  .get(
    "/hello",
    validator("query", (value) => {
      const { name } = value;
      return { name: typeof name === "string" && name.trim() !== "" ? name.trim() : "there" };
    }),
    (c) => c.json({ message: `Hello, ${c.req.valid("query").name}. The app answered.` }),
  );

export type AppType = typeof app;

export default app;
