import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import getPort, { portNumbers } from "get-port";
import { getProjectOverview, searchProject } from "canary-core";
import type { CanaryConnection } from "canary-core";

const MAX_FILE_SIZE = 512 * 1024;

interface CreateCanaryServerParams {
  connection: CanaryConnection;
  sessionId: string;
  requestedPort?: number;
}

export interface CanaryServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

function getClientDistDir(): string {
  return fileURLToPath(new URL("../../dist/client", import.meta.url));
}

export async function createCanaryServer({
  connection,
  sessionId,
  requestedPort
}: CreateCanaryServerParams): Promise<CanaryServerHandle> {
  const app = express();
  const port = requestedPort ?? (await getPort({ port: portNumbers(4100, 4199) }));
  const clientDistDir = getClientDistDir();
  const hasClientBuild = fs.existsSync(path.join(clientDistDir, "index.html"));

  app.get("/health", (_request, response) => {
    response.json({
      ok: true
    });
  });

  app.get("/api/overview", async (_request, response, next) => {
    try {
      const overview = await getProjectOverview(connection, sessionId);
      response.json(overview);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/file", (request, response) => {
    const filePath = typeof request.query.path === "string" ? request.query.path : "";
    if (!filePath) {
      response.status(400).json({ error: "Missing path parameter." });
      return;
    }

    const resolved = path.resolve(connection.projectRoot, filePath);
    if (!resolved.startsWith(connection.projectRoot)) {
      response.status(403).json({ error: "Path traversal not allowed." });
      return;
    }

    try {
      const stat = fs.statSync(resolved);
      if (stat.size > MAX_FILE_SIZE) {
        response.status(413).json({ error: "File too large." });
        return;
      }

      const content = fs.readFileSync(resolved, "utf-8");
      response.json({ content, path: filePath });
    } catch {
      response.status(404).json({ error: "File not found." });
    }
  });

  app.get("/api/search", async (request, response, next) => {
    try {
      const query = typeof request.query.q === "string" ? request.query.q.trim() : "";
      if (!query) {
        response.json([]);
        return;
      }

      const results = await searchProject(connection, query);
      response.json(results);
    } catch (error) {
      next(error);
    }
  });

  if (hasClientBuild) {
    app.use(express.static(clientDistDir));
    app.use((_request, response) => {
      response.sendFile(path.join(clientDistDir, "index.html"));
    });
  } else {
    app.use((_request, response) => {
      response.type("html").send(`
        <html>
          <body style="font-family: Avenir Next, sans-serif; padding: 32px;">
            <h1>Canary UI is not built yet.</h1>
            <p>Run <code>pnpm --filter canary build</code> and reopen this session.</p>
          </body>
        </html>
      `);
    });
  }

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const instance = app.listen(port, "127.0.0.1", () => resolve(instance));
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
