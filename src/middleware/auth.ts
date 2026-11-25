import type { NextFunction, Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { adminAuth } from '../lib/firebase-admin.ts';
import { db } from '../db/index.ts';
import {
  organisationMemberships,
  organisations,
  users,
} from '../db/schema.ts';
import { seedDemoOrganisationForUser } from '../services/demoSeed.ts';

export type OrgRole = 'Administrator' | 'Operations Manager' | 'Technician';

export interface AuthContext {
  userId: string;
  uid: string;
  email: string;
  displayName: string;
  organisationId: string;
  organisationName: string;
  isDemoOrg: boolean;
  role: OrgRole;
  assignedInstallationIds: string[];
}

export interface AuthRequest extends Request {
  auth?: AuthContext;
}

export async function resolveUserAndOrg(
  uid: string,
  email: string,
  displayName: string,
  requestedOrgId?: string
): Promise<AuthContext> {
  const normalizedEmail = email.toLowerCase();

  const [dbUser] = await db
    .insert(users)
    .values({
      uid,
      email: normalizedEmail,
      displayName: displayName || normalizedEmail.split('@')[0],
    })
    .onConflictDoUpdate({
      target: users.uid,
      set: {
        email: normalizedEmail,
        displayName: displayName || normalizedEmail.split('@')[0],
      },
    })
    .returning();

  // Claim any pending invitations matching this user's email
  await db
    .update(organisationMemberships)
    .set({ userId: dbUser.id, status: 'ACTIVE' })
    .where(
      and(
        eq(organisationMemberships.invitedEmail, normalizedEmail),
        eq(organisationMemberships.status, 'INVITED')
      )
    );

  let memberships = await db
    .select({
      membershipId: organisationMemberships.id,
      organisationId: organisationMemberships.organisationId,
      role: organisationMemberships.role,
      assignedInstallationIds: organisationMemberships.assignedInstallationIds,
      orgName: organisations.name,
      isDemo: organisations.isDemo,
    })
    .from(organisationMemberships)
    .innerJoin(organisations, eq(organisationMemberships.organisationId, organisations.id))
    .where(eq(organisationMemberships.userId, dbUser.id));

  if (memberships.length === 0) {
    await seedDemoOrganisationForUser(dbUser.id, normalizedEmail);
    memberships = await db
      .select({
        membershipId: organisationMemberships.id,
        organisationId: organisationMemberships.organisationId,
        role: organisationMemberships.role,
        assignedInstallationIds: organisationMemberships.assignedInstallationIds,
        orgName: organisations.name,
        isDemo: organisations.isDemo,
      })
      .from(organisationMemberships)
      .innerJoin(organisations, eq(organisationMemberships.organisationId, organisations.id))
      .where(eq(organisationMemberships.userId, dbUser.id));
  }

  const active =
    (requestedOrgId
      ? memberships.find((m) => m.organisationId === requestedOrgId)
      : undefined) || memberships[0];

  if (!active) {
    throw new Error('No active organisation membership found for user.');
  }

  return {
    userId: dbUser.id,
    uid: dbUser.uid,
    email: dbUser.email,
    displayName: dbUser.displayName || dbUser.email,
    organisationId: active.organisationId,
    organisationName: active.orgName,
    isDemoOrg: active.isDemo,
    role: active.role as OrgRole,
    assignedInstallationIds: Array.isArray(active.assignedInstallationIds)
      ? active.assignedInstallationIds
      : [],
  };
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required. Missing Bearer token.' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const requestedOrgId =
      typeof req.headers['x-organisation-id'] === 'string'
        ? req.headers['x-organisation-id']
        : undefined;

    const ctx = await resolveUserAndOrg(
      decoded.uid,
      decoded.email || `${decoded.uid}@unknown.local`,
      decoded.name || decoded.email || 'Operator',
      requestedOrgId
    );
    req.auth = ctx;
    next();
  } catch (error) {
    console.error('Auth verification failed:', error);
    res.status(401).json({ error: 'Invalid or expired authentication token.' });
  }
};

export const requireRole = (allowedRoles: OrgRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.auth) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!allowedRoles.includes(req.auth.role)) {
      res.status(403).json({
        error: `Insufficient permissions. Requires role: ${allowedRoles.join(' or ')}.`,
      });
      return;
    }
    next();
  };
};
