import { randomUUID } from 'node:crypto';
import { DEMO_USER } from '@hydro/config';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Role } from '@hydro/shared-types';
import type { AppContext } from '../context.js';
import { hashPassword, verifyPassword } from '../plugins/auth.js';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(6).max(200) });
const registerSchema = loginSchema.extend({
  fullName: z.string().min(1).max(120),
  organization: z.string().max(200).optional(),
});

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const issue = async (user: { id: string; email: string; role: Role }) => ({
    accessToken: app.jwt.sign({ sub: user.id, email: user.email, role: user.role, type: 'access' }, { expiresIn: ctx.config.auth.accessTokenTtl }),
    refreshToken: app.jwt.sign({ sub: user.id, email: user.email, role: user.role, type: 'refresh' }, { expiresIn: ctx.config.auth.refreshTokenTtl }),
    expiresIn: 1800,
    tokenType: 'Bearer' as const,
  });

  app.post('/api/auth/login', {
    schema: {
      tags: ['auth'],
      summary: 'Exchange credentials for an access and refresh token pair.',
      body: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'A valid email and a password of at least 6 characters are required.', details: parsed.error.issues } });
    }
    const { email, password } = parsed.data;
    const user = await ctx.store.db.findUserByEmail(email);
    // Constant-ish work whether or not the account exists, so timing does not
    // reveal which emails are registered.
    const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const okPassword = verifyPassword(password, hash);
    if (!user || !okPassword || !user.isActive) {
      return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' } });
    }
    await ctx.store.db.recordLogin(user.id);
    return {
      data: {
        tokens: await issue(user),
        user: { id: user.id, email: user.email, fullName: user.fullName, organization: user.organization, role: user.role, createdAt: user.createdAt },
      },
    };
  });

  app.post('/api/auth/register', {
    schema: { tags: ['auth'], summary: 'Create an account.' },
  }, async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'Invalid registration details.', details: parsed.error.issues } });
    }
    const { email, password, fullName, organization } = parsed.data;
    if (await ctx.store.db.findUserByEmail(email)) {
      return reply.code(409).send({ error: { code: 'EMAIL_TAKEN', message: 'An account already exists for that email address.' } });
    }
    const user = await ctx.store.db.createUser({
      id: randomUUID(),
      email,
      fullName,
      organization: organization ?? null,
      role: 'analyst',
      passwordHash: hashPassword(password),
      isActive: true,
    });
    return reply.code(201).send({
      data: {
        tokens: await issue(user),
        user: { id: user.id, email: user.email, fullName: user.fullName, organization: user.organization, role: user.role, createdAt: user.createdAt },
      },
    });
  });

  app.post('/api/auth/refresh', { schema: { tags: ['auth'], summary: 'Exchange a refresh token for a new access token.' } }, async (req, reply) => {
    const token = (req.body as { refreshToken?: string })?.refreshToken;
    if (!token) return reply.code(400).send({ error: { code: 'MISSING_TOKEN', message: 'A refreshToken is required.' } });
    try {
      const payload = app.jwt.verify(token) as unknown as { sub: string; email: string; role: Role; type: string };
      if (payload.type !== 'refresh') throw new Error('not a refresh token');
      const user = await ctx.store.db.findUserById(payload.sub);
      if (!user || !user.isActive) throw new Error('inactive');
      return { data: { tokens: await issue(user) } };
    } catch {
      return reply.code(401).send({ error: { code: 'INVALID_REFRESH_TOKEN', message: 'The refresh token is invalid or has expired.' } });
    }
  });

  app.get('/api/auth/me', { preHandler: [app.authenticate], schema: { tags: ['auth'], summary: 'The authenticated user.' } }, async (req) => {
    const user = await ctx.store.db.findUserById(req.user!.id);
    return {
      data: user
        ? { id: user.id, email: user.email, fullName: user.fullName, organization: user.organization, role: user.role, createdAt: user.createdAt }
        : null,
    };
  });

  app.get('/api/auth/demo-credentials', { schema: { tags: ['auth'], summary: 'Demonstration account credentials, when demo login is enabled.' } }, async () => ({
    data: ctx.config.auth.allowDemoLogin
      ? {
          enabled: true,
          email: DEMO_USER.email,
          password: DEMO_USER.password,
          note: 'The demonstration account is enabled because ALLOW_DEMO_LOGIN is not disabled and NODE_ENV is not production. Disable it before any real deployment.',
        }
      : { enabled: false, note: 'Demonstration login is disabled in this deployment.' },
  }));
}
