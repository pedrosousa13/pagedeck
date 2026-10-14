import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { validator } from "hono/validator";

// Before `basePath`, so the middleware also covers a path with no file, which reaches the
// Worker too.
const app = new Hono()
  .use(secureHeaders())
  .use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  })
  .basePath("/api")
  .post(
    "/signup",
    validator("json", (value: { email?: unknown }, c) => {
      const { email } = value;
      if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(email)) {
        return c.json({ error: "Enter an email address." }, 400);
      }
      return { email };
    }),
    (c) => c.json({ message: `Thanks. We will write to ${c.req.valid("json").email}.` }, 201),
  );

export type AppType = typeof app;

export default app;
