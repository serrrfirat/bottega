/**
 * Bottega server entrypoint: Slack adapter + space service (Slice 1+).
 * Stub: serves a placeholder response on an ephemeral port until SIGINT.
 */
export function main() {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("bottega stub"),
  });
  console.log(`bottega server stub: listening on :${server.port}`);
  return server;
}

if (import.meta.main) {
  const server = main();
  process.on("SIGINT", () => {
    server.stop(true);
    console.log("bottega server stub: shutting down");
    process.exit(0);
  });
}
