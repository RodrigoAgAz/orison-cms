import { compare, hash } from "bcryptjs";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { jwtVerify, SignJWT } from "jose";

import { prisma, type Role, type User } from "@orison/db";

import { env } from "./env";
import { ApiError } from "./http";
import { phoneAppRequiresSignIn, PHONE_APP_REQUIRE_SIGN_IN_ENV, requestAddress, SHARED_PHONE_ACTOR } from "./phone-access";
import { sessionVersionMatches } from "./session-version";

export const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 30;

type SessionUser = Pick<User, "id" | "email" | "name" | "role" | "sessionVersion">;

const sessionUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  sessionVersion: true,
  createdAt: true,
} as const;

const jwtSecret = new TextEncoder().encode(env.sessionSecret);

export async function hashPassword(password: string) {
  return hash(password, 10);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return compare(password, passwordHash);
}

export async function issueSessionToken(user: SessionUser) {
  return new SignJWT({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    // Session version: bumped on password change, admin reset and role change (signs out
    // every other device). Checked against the database wherever a session becomes a user.
    sv: user.sessionVersion,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_LIFETIME_SECONDS}s`)
    .sign(jwtSecret);
}

export async function verifySessionToken(token: string) {
  const { payload } = await jwtVerify(token, jwtSecret);
  return payload as {
    sub: string;
    email: string;
    name: string;
    role: Role;
    sv?: number;
  };
}

export async function createSession(user: SessionUser) {
  const token = await issueSessionToken(user);
  const cookieStore = cookies();
  cookieStore.set(env.sessionCookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_LIFETIME_SECONDS,
  });
  return token;
}

export async function clearSession() {
  const cookieStore = cookies();
  cookieStore.delete(env.sessionCookieName);
}

/**
 * The signed-in user, re-read from the database: null when there is no valid token, the user no
 * longer exists, or the token's session version is out of date (signed out everywhere). The
 * middleware only checks the token signature (it runs on the edge without database access), so
 * every page and API route turns the session into a user through here.
 */
export async function getSessionUser() {
  const cookieStore = cookies();
  const token = cookieStore.get(env.sessionCookieName)?.value;
  if (!token) {
    return null;
  }

  let payload: Awaited<ReturnType<typeof verifySessionToken>>;
  try {
    payload = await verifySessionToken(token);
  } catch {
    return null;
  }
  if (typeof payload.sub !== "string") {
    return null;
  }
  const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: sessionUserSelect });
  if (!user || !sessionVersionMatches(payload.sv, user.sessionVersion)) {
    return null;
  }
  return user;
}

export async function requireUser() {
  const user = await getSessionUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}

export async function requireUserFromDb() {
  const session = await getSessionUser();
  if (!session) {
    redirect("/login");
  }

  const user = await prisma.user.findUnique({ where: { id: session.id } });
  if (!user) {
    redirect("/login");
  }

  return user;
}

export async function authenticateUser(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return null;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return null;
  }

  return user;
}


/**
 * For JSON API routes (every route except the device endpoints): the signed-in user, re-read
 * from the database so deleted users, role changes and revoked sessions take effect at once.
 * Throws ApiError(401) otherwise.
 */
export async function requireApiUser() {
  const user = await getSessionUser();
  if (!user) {
    throw new ApiError("Unauthenticated", 401);
  }
  return user;
}

/**
 * Sign the user out on every device (bump the session version). Pass `keepCurrentSession` when the
 * signed-in user changed their own credentials, to re-issue this device's cookie.
 */
export async function revokeUserSessions(userId: string, options: { keepCurrentSession?: boolean } = {}) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
    select: sessionUserSelect,
  });
  if (options.keepCurrentSession) {
    await createSession(user);
  }
  return user;
}

export async function requireApiAdmin() {
  const user = await requireApiUser();
  if (user.role !== "ADMIN") {
    throw new ApiError("Only admins can manage the team", 403);
  }
  return user;
}

/** Whether the phone app requires sign-in (PHONE_APP_REQUIRE_SIGN_IN). Read per call, at runtime. */
export function phoneAppSignInRequired() {
  return phoneAppRequiresSignIn(process.env[PHONE_APP_REQUIRE_SIGN_IN_ENV]);
}

/**
 * Who is acting in the phone app. A signed-in user is that user. Otherwise, while the phone app is
 * open (the default), the shared identity SHARED_PHONE_ACTOR with the caller's address; with
 * PHONE_APP_REQUIRE_SIGN_IN=true, ApiError(401) exactly like requireApiUser.
 *
 * `id` and `name` are always set, so code that records "who did this" keeps working; the shared
 * identity's id is not a user row and is never looked up.
 */
export type PhoneActor = {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  anonymous: boolean;
  ip: string | null;
  forwardedFor: string | null;
};

export async function requirePhoneAppActor(): Promise<PhoneActor> {
  const user = await getSessionUser();
  if (user) {
    return { id: user.id, name: user.name, email: user.email, role: user.role, anonymous: false, ip: null, forwardedFor: null };
  }
  if (phoneAppSignInRequired()) {
    throw new ApiError("Unauthenticated", 401);
  }
  const address = requestAddress(headers());
  return { ...SHARED_PHONE_ACTOR, email: null, anonymous: true, ...address };
}

/** Activity-log metadata naming the actor (and, for the shared identity, the request address). */
export function actorMetadata(actor: Pick<PhoneActor, "id" | "name" | "anonymous" | "ip" | "forwardedFor">) {
  return actor.anonymous
    ? { userId: actor.id, userName: actor.name, anonymous: true, ip: actor.ip, forwardedFor: actor.forwardedFor }
    : { userId: actor.id, userName: actor.name };
}
