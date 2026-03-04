import type { NextFunction, Request, Response } from "express";
import type { Role } from "@agentfoundry/shared";

export function requireRoles(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }

    if (req.user.role === "ADMIN") {
      next();
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({ error: "Forbidden for current role" });
      return;
    }

    next();
  };
}
