import { Hono } from "hono";
import type { Context } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { validator } from "hono/validator";

// The island asks for JSON; a form posted without JavaScript is a navigation, and gets a page.
const wantsJson = (c: Context) => c.req.header("Accept")?.includes("application/json") === true;

// Before `basePath`, so the middleware and the error handler also cover a path with no file,
// which reaches the Worker too.
const app = new Hono()
  .use(secureHeaders())
  .use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  })
  .onError((error, c) =>
    c.json({ error: "Something went wrong. Try again." }, error instanceof HTTPException ? error.status : 500),
  )
  .basePath("/api")
  .use(csrf())
  .post(
    "/signup",
    validator("form", (value: { email?: string }, c) => {
      const { email } = value;
      if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(email)) {
        return wantsJson(c)
          ? c.json({ error: "Enter an email address." }, 400)
          : c.redirect("/signup/invalid/", 303);
      }
      return { email };
    }),
    (c) =>
      wantsJson(c)
        ? c.json({ message: `Thanks. We will write to ${c.req.valid("form").email}.` }, 201)
        : c.redirect("/signup/thanks/", 303),
  );

export type AppType = typeof app;

export default app;
