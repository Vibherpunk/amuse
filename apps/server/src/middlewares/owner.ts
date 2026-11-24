import type { NextFunction, Request, Response } from "express";
import type { AuthUser } from "../lib/types";

/** Amuse runs on your own machine for one person, so every request acts as that owner. */
export const OWNER_ID = "owner";

declare global {
  namespace Express {
    interface User extends AuthUser {}
    interface Request {
      user?: User;
    }
  }
}

export function ownerMiddleware(req: Request, _res: Response, next: NextFunction) {
  req.user = { id: OWNER_ID };
  next();
}

/**
 * Only answers requests addressed to localhost, and only accepts changes from Amuse's own pages,
 * so other websites open in your browser (including DNS-rebinding tricks and sandboxed frames)
 * can't drive your agent.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "your-mac.local"]);
const hostname = (host: string) => host.toLowerCase().replace(/:\d+$/, "");
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function localOnlyGuard(req: Request, res: Response, next: NextFunction) {
  const host = req.headers.host ?? "";
  if (!LOCAL_HOSTS.has(hostname(host))) {
    res.status(403).send("Amuse only accepts requests to localhost.");
    return;
  }
  const site = req.headers["sec-fetch-site"];
  const origin = req.headers.origin;
  let sameOrigin = false;
  try {
    sameOrigin = !!origin && new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {}
  if (origin && !sameOrigin) {
    // Includes "null", the origin of sandboxed frames and generated pages.
    res.status(403).json({ error: "Cross-origin requests are not allowed" });
    return;
  }
  if (!SAFE_METHODS.has(req.method)) {
    if (site && site !== "same-origin") {
      res.status(403).json({ error: "Cross-site requests are not allowed" });
      return;
    }
    // HTML forms can't send JSON, so requiring it rules out form-based request forgery.
    if (req.method !== "DELETE" && !req.is("application/json")) {
      res.status(415).json({ error: "Send JSON (Content-Type: application/json)" });
      return;
    }
  }
  next();
}

/** Amuse's own pages can't be framed by other sites; generated pages set their own policy. */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  if (!/^\/api\/(artifacts|spaces)\/\d+\/raw$/.test(req.path)) {
    res.setHeader("X-Frame-Options", "DENY");
    // frame-src 'self' also stops a generated page from navigating its frame to another site.
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; frame-src 'self'");
  }
  next();
}
