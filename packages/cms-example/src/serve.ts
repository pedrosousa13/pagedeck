import { startCms } from "./server.js";

const DEFAULT_PORT = 4310;

const argument = process.argv[2];
if (argument !== undefined && !(/^\d{1,5}$/.test(argument) && Number(argument) <= 65535)) {
  console.error(
    `Port "${argument}": is not a port number — pass a whole number from 0 to 65535, or nothing to serve on ${String(DEFAULT_PORT)}`,
  );
  process.exit(2);
}

const cms = await startCms({ port: argument === undefined ? DEFAULT_PORT : Number(argument) });
console.log(`CMS serving at ${cms.url}`);
