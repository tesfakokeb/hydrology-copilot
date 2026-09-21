import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Role } from '@hydro/shared-types';
import type { DataAccess } from '../store/types.js';

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  type: 'access' | 'refresh';
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: AuthenticatedUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: preHandlerAsyncHookHandler;
  }
}

/** Role hierarchy used by requireRole. */
const RANK: Record<Role, number> = { viewer: 0, analyst: 1, modeler: 2, admin: 3 };

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

/**
 * Authentication guard. Verifies the bearer token, loads the user, and
 * attaches it to the request. Every route except /api/health, /api/status and
 * /api/auth/* is behind this.
 */
export function makeAuthGuard(db: DataAccess) {
  return async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const payload = (await req.jwtVerify()) as unknown as JwtPayload;
      if (payload.type !== 'access') {
        return reply.code(401).send({ error: { code: 'INVALID_TOKEN_TYPE', message: 'A refresh token cannot be used to access the API.' } });
      }
      const user = await db.findUserById(payload.sub);
      if (!user || !user.isActive) {
        return reply.code(401).send({ error: { code: 'USER_INACTIVE', message: 'This account is no longer active.' } });
      }
      req.user = { id: user.id, email: user.email, role: user.role };
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'A valid bearer token is required.' } });
    }
  };
}

/** Role-based access control (§31). */
export function requireRole(minimum: Role) {
  return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.user) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } });
    }
    if (RANK[req.user.role] < RANK[minimum]) {
      return reply.code(403).send({
        error: {
          code: 'FORBIDDEN',
          message: `This action requires the "${minimum}" role or higher. Your role is "${req.user.role}".`,
        },
      });
    }
  };
}

export function registerAuthDecorators(app: FastifyInstance, db: DataAccess): void {
  app.decorate('authenticate', makeAuthGuard(db) as preHandlerAsyncHookHandler);
}
