// Hono adapter that wraps the framework-agnostic dispatcher (ADR-0021).
//
// Hono is the *initial* dispatcher because of `hono/aws-lambda` — slice 9
// mounts the same handlers behind API Gateway with a single entry-point
// file change. None of the route logic depends on Hono; this file is the
// only place it leaks in.
//
// Slice 7 binds to 127.0.0.1 only and CORS-allows http://localhost:5173
// (the Vite default for slice 8). Both guards go away in slice 9 alongside
// Cognito JWT validation.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { dispatch, type BffDeps } from "./dispatcher.js";

export type HonoAppDeps = BffDeps & {
  // Slice 8 dev origin. Defaults to Vite's loopback (both 127.0.0.1 and
  // localhost variants — they resolve identically but the browser treats
  // them as distinct origins). Slice 9 replaces this with the deployed
  // webmail origin and a single string.
  corsOrigin?: string | string[];
};

const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export function makeHonoApp(deps: HonoAppDeps): Hono {
  const app = new Hono();

  const allowed =
    deps.corsOrigin === undefined
      ? DEFAULT_DEV_ORIGINS
      : Array.isArray(deps.corsOrigin)
        ? deps.corsOrigin
        : [deps.corsOrigin];

  app.use(
    "/rpc/*",
    cors({
      origin: (origin) => (allowed.includes(origin) ? origin : null),
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/rpc/:tool", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          code: "invalid_request",
          field: "body",
          reason: "invalid_type",
          message: "request body must be valid JSON",
        },
        400,
      );
    }
    const result = await dispatch(deps, c.req.path, body);
    // Hono's c.json wants a numeric status; the dispatcher's status is
    // already a plain number from the table in ADR-0021.
    return c.json(result.body as Record<string, unknown>, result.status as 200);
  });

  return app;
}
