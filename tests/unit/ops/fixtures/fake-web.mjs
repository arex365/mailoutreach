// Stand-in for `next start` in the supervisor test: answers /api/health on PORT.
import http from "node:http";

const port = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, database: "ok", workerLastSeen: null }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1", () => {
  console.log(`fake web listening on ${port} NODE_ENV=${process.env.NODE_ENV} DATABASE_URL=${process.env.DATABASE_URL}`);
});
