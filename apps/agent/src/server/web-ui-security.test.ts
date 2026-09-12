import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { request as httpRequest } from "node:http";
import { FakeAdbProvider } from "@droid-webscr/adb";
import { createFastifyApp, registerWebUiRoutes } from "./create-fastify-app.js";

const token = "bootstrap-secret";
const renderIndex = async () => `<script>window.token="${token}"</script>`;

describe("web UI host boundary", () => {
  it("keeps reserved API and WebSocket paths out of development middleware", async () => {
    const seenUrls: string[] = [];
    const app = await createFastifyApp({
      adbProvider: new FakeAdbProvider([]),
      config: { authToken: token, bindHost: "0.0.0.0", port: 7391, clipboard: { enabled: false } },
      logger: false,
      webUi: {
        renderIndex,
        devMiddleware: (request, response) => {
          seenUrls.push(request.url ?? "");
          response.end("development module");
        },
      },
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP listener");
      }
      await Promise.all(
        ["localhost:7391", "attacker.example:7391"].flatMap((host) =>
          ["/api/../src/main.tsx", "/ws/../src/main.tsx"].map(async (url) => {
            const status = await new Promise<number | undefined>((resolve, reject) => {
              const request = httpRequest(
                { host: "127.0.0.1", port: address.port, path: url, headers: { host } },
                (response) => {
                  response.resume();
                  response.on("end", () => resolve(response.statusCode));
                },
              );
              request.on("error", reject);
              request.end();
            });
            expect(status).toBe(404);
          }),
        ),
      );
      expect(seenUrls).toEqual([]);
      const api = await app.inject({ url: "/api/health" });
      expect(api.json()).toMatchObject({ status: "ok" });
      expect(seenUrls).toEqual([]);
      const source = await app.inject({ url: "/src/main.tsx" });
      expect(source.statusCode).toBe(200);
      expect(source.body).toBe("development module");
    } finally {
      await app.close();
    }
  });

  it.each(["127.0.0.1", "0.0.0.0", "::"])(
    "rejects hostile hosts before UI middleware when bound to %s",
    async (bindHost) => {
      const app = await createFastifyApp({
        adbProvider: new FakeAdbProvider([]),
        config: { authToken: token, bindHost, port: 7391, clipboard: { enabled: false } },
        logger: false,
        webUi: {
          renderIndex,
          devMiddleware: (request, response, next) => {
            if (request.url === "/middleware") {
              response.end(token);
            } else {
              next();
            }
          },
        },
      });
      try {
        await Promise.all(
          ["/", "/devices/example", "/missing.js", "/middleware"].map(async (url) => {
            const response = await app.inject({
              url,
              headers: { host: "attacker.example:7391", "x-forwarded-host": "localhost:7391" },
              remoteAddress: "127.0.0.1",
            });
            expect(response.statusCode, url).toBe(403);
            expect(response.body).not.toContain(token);
          }),
        );
        const legitimate = await app.inject({ url: "/", headers: { host: "localhost:7391" } });
        expect(legitimate.statusCode).toBe(200);
        expect(legitimate.body).toContain(token);
      } finally {
        await app.close();
      }
    },
  );

  it("protects standalone UI routes and rejects malformed authority forms", async () => {
    const app = Fastify();
    registerWebUiRoutes(app, { renderIndex });
    try {
      await Promise.all(
        [
          "attacker.example:7391",
          "localhost.attacker.example:7391",
          "localhost@attacker.example:7391",
          "[::1]attacker.example:7391",
          "localhost:7391/path",
          "localhost:invalid",
          "localhost:65536",
          "localhost:0",
        ].map(async (host) => {
          const response = await app.inject({ url: "/", headers: { host } });
          expect(response.statusCode, host).toBe(403);
          expect(response.body).not.toContain(token);
        }),
      );
      await Promise.all(
        ["localhost", "LOCALHOST:7391", "127.0.0.1:7391", "[::1]:7391"].map(async (host) => {
          const response = await app.inject({ url: "/", headers: { host } });
          expect(response.statusCode, host).toBe(200);
          expect(response.body).toContain(token);
        }),
      );
      const remote = await app.inject({
        url: "/",
        headers: { host: "localhost:7391" },
        remoteAddress: "192.168.1.44",
      });
      expect(remote.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
