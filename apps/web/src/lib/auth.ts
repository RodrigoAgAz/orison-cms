import { compare, hash } from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { jwtVerify, SignJWT } from "jose";

import { prisma, type Role, type User } from "@orison/db";

import { env } from "./env";

type SessionUser = Pick<User, "id" | "email" | "name" | "role">;

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
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(jwtSecret);
}

export async function verifySessionToken(token: string) {
  const { payload } = await jwtVerify(token, jwtSecret);
  return payload as {
    sub: string;
    email: string;
    name: string;
    role: Role;
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
    maxAge: 60 * 60 * 24 * 7,
  });
  return token;
}

export async function clearSession() {
  const cookieStore = cookies();
  cookieStore.delete(env.sessionCookieName);
}

export async function getSessionUser() {
  const cookieStore = cookies();
  const token = cookieStore.get(env.sessionCookieName)?.value;
  if (!token) {
    return null;
  }

  try {
    const payload = await verifySessionToken(token);
    return {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    } satisfies SessionUser;
  } catch {
    return null;
  }
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

