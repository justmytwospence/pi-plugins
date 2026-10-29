// Stands in for `marimo edit` in servers.test.ts: serves /health on --port, or fails with --fail.
import { createServer } from "node:http";

const args = process.argv.slice(2);
if (args.includes("--fail")) {
  console.error("boom: no notebook");
  process.exit(3);
}
const port = Number(args[args.indexOf("--port") + 1]);
createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 404);
  res.end("ok");
}).listen(port, "127.0.0.1", () => console.log(`URL: http://127.0.0.1:${port}`));
