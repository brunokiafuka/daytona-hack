import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.DASHBOARD_PORT ?? 4173);
const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };

createServer((request, response) => {
  const requestPath = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
  const relative = requestPath === "/" ? "index.html" : normalize(requestPath).replace(/^[/\\]+/, "");
  const file = join(root, relative);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": contentTypes[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(response);
}).listen(port, () => console.log(`Agent Atlas running at http://localhost:${port}`));
