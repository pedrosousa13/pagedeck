import { chromium } from "playwright";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { build, clean, serve, stop } from "./wrangler.test-support.js";
import type { Served } from "./wrangler.test-support.js";

const ADDRESS = "reader@example.com";
const THANKS = `Thanks. We will write to ${ADDRESS}.`;
const FAILED =
  "Something went wrong, so you are not signed up yet. Your address is still in the form: try again.";
const SECRET = "token=s3cr3t";

let browser: Browser | undefined;
let served: Served | undefined;
let context: BrowserContext | undefined;
const pageErrors: string[] = [];
const posts: string[] = [];

beforeAll(async () => {
  await build();
  served = await serve();
  browser = await chromium.launch();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await stop(served);
  clean();
});

afterEach(async () => {
  await context?.close();
  context = undefined;
  expect(pageErrors, "an uncaught error or unhandled rejection in the page").toEqual([]);
});

async function open(options: { javaScriptEnabled?: boolean; hydrate?: boolean } = {}): Promise<Page> {
  if (browser === undefined || served === undefined) throw new Error("harness not started");
  pageErrors.length = 0;
  posts.length = 0;
  context = await browser.newContext({ javaScriptEnabled: options.javaScriptEnabled ?? true });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(`${request.url()} ${request.postData() ?? ""}`);
  });
  if (options.hydrate === false) await page.route("**/assets/fw-core-*.js", (route) => route.abort());
  await page.goto(`${served.origin}/signup/`);
  if (options.hydrate !== false && options.javaScriptEnabled !== false) {
    // React marks the element it hydrated; until then a submit is a plain form post. Polled with
    // `page.evaluate`: `waitForFunction` runs through `eval`, which a site's CSP may refuse.
    await expect
      .poll(() =>
        page.evaluate(
          `Object.keys(document.querySelector("form") ?? {}).some((key) => key.startsWith("__react"))`,
        ),
      )
      .toBe(true);
  }
  return page;
}

function status(page: Page): Promise<string | null> {
  return page.getByRole("status").textContent();
}

async function send(page: Page, address: string): Promise<void> {
  await page.getByLabel("Email address").fill(address);
  await page.getByRole("button", { name: "Sign up" }).click();
}

test("a valid address is signed up and announced", async () => {
  const page = await open();
  await send(page, ADDRESS);
  await expect.poll(() => status(page)).toBe(THANKS);
  expect(page.url()).toMatch(/\/signup\/$/);
  expect(posts).toHaveLength(1);
});

// `type="email"` accepts `reader@localhost`; the app's own check refuses it.
test("the app's refusal is announced against the field, which keeps its value", async () => {
  const page = await open();
  await send(page, "reader@localhost");
  await expect.poll(() => status(page)).toBe("Enter an email address.");
  const field = page.getByLabel("Email address");
  expect(await field.inputValue()).toBe("reader@localhost");
  expect(await field.getAttribute("aria-invalid")).toBe("true");
  expect(await field.getAttribute("aria-describedby")).toBe(await page.getByRole("status").getAttribute("id"));
});

test("a malformed address never leaves the page", async () => {
  const page = await open();
  await send(page, "no-at-sign");
  expect(await page.evaluate(`document.querySelector("input").validity.valid`)).toBe(false);
  await send(page, ADDRESS);
  await expect.poll(() => status(page)).toBe(THANKS);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain(ADDRESS);
});

test("a slow answer shows the pending state, and pressing again sends nothing more", async () => {
  const page = await open();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/signup", async (route: Route) => {
    await held;
    await route.continue();
  });
  await send(page, ADDRESS);
  await expect.poll(() => status(page)).toBe("Signing up…");
  const button = page.getByRole("button", { name: "Sign up" });
  expect(await button.getAttribute("aria-disabled")).toBe("true");
  // `force`, because Playwright waits for an `aria-disabled` button to enable; a reader does not.
  await button.click({ force: true });
  await page.getByLabel("Email address").press("Enter");
  release();
  await expect.poll(() => status(page)).toBe(THANKS);
  expect(posts).toHaveLength(1);
  expect(await button.getAttribute("aria-disabled")).toBe("false");
});

test("a request that never arrives is announced, and a retry with the kept address succeeds", async () => {
  const page = await open();
  await page.route("**/api/signup", (route) => route.abort("internetdisconnected"));
  await send(page, ADDRESS);
  await expect.poll(() => status(page)).toBe(FAILED);
  expect(await page.getByLabel("Email address").inputValue()).toBe(ADDRESS);
  await page.unroute("**/api/signup");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect.poll(() => status(page)).toBe(THANKS);
});

test("a server failure that is not the app's JSON is announced without its body, and a retry succeeds", async () => {
  const page = await open();
  await page.route("**/api/signup", (route) =>
    route.fulfill({ status: 502, contentType: "text/html", body: `<h1>Bad gateway</h1><p>${SECRET}</p>` }),
  );
  await send(page, ADDRESS);
  await expect.poll(() => status(page)).toBe(FAILED);
  expect(await page.content()).not.toContain(SECRET);
  await page.unroute("**/api/signup");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect.poll(() => status(page)).toBe(THANKS);
});

for (const [label, options] of [
  ["without JavaScript", { javaScriptEnabled: false }],
  ["before the island hydrates", { hydrate: false }],
] as const) {
  test(`${label}, the form posts and lands on a page whose URL holds no address`, async () => {
    const page = await open(options);
    await page.getByLabel("Email address").fill(ADDRESS);
    await Promise.all([page.waitForURL("**/signup/thanks/"), page.getByRole("button", { name: "Sign up" }).click()]);
    expect(page.url()).not.toContain("@");
    expect(page.url()).not.toContain("reader");
    expect(posts).toEqual([`${served?.origin ?? ""}/api/signup email=reader%40example.com`]);
    expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe("Thanks");
  });
}
