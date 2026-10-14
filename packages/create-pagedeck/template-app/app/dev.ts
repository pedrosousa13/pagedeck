import { serve } from "@hono/node-server";
import app from "./index.ts";

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 8787 }, ({ port }) => {
  console.log(`The app answers /api/ at http://127.0.0.1:${String(port)}`);
});
