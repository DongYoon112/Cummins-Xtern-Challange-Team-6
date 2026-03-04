import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { Role } from "@agentfoundry/shared";

export type AuthUser = {
  id: string;
  username: string;
  role: Role;
  teamId: string;
};

const JWT_SECRET = process.env.JWT_SECRET ?? "agentfoundry-dev-secret";

export function signToken(user: AuthUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "12h" });
}

export function verifyToken(token: string): AuthUser {
  return jwt.verify(token, JWT_SECRET) as AuthUser;
}

export function authRequired(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const token = authHeader.slice("Bearer ".length);
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}