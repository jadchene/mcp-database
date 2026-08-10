import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ApplicationError } from "./errors.js";

const CONFIRMATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface StoredChallenge {
  version: 1;
  salt: string;
  passwordDigest: string;
  expiresAt: number;
}

interface StoredAuthorization {
  version: 1;
  digest: string;
  expiresAt: number;
}

interface AuthorizationOptions {
  directory?: string;
  now?: () => number;
}

export async function generateUserAuthorization(
  confirmationId: string,
  password: string,
  options: AuthorizationOptions = {}
): Promise<string> {
  assertConfirmationId(confirmationId);

  const directory = options.directory ?? defaultAuthorizationDirectory();
  const challenge = await readChallenge(directory, confirmationId);
  if (challenge.expiresAt <= (options.now ?? Date.now)()) {
    await removeAuthorizationFiles(directory, confirmationId);
    throw new ApplicationError("INVALID_ARGUMENT", "Unknown or expired confirmation identifier");
  }

  const actualPasswordDigest = derivePasswordDigest(password, challenge.salt);
  const expectedPasswordDigest = Buffer.from(challenge.passwordDigest, "hex");
  if (
    actualPasswordDigest.length !== expectedPasswordDigest.length ||
    !timingSafeEqual(actualPasswordDigest, expectedPasswordDigest)
  ) {
    throw new ApplicationError("INVALID_ARGUMENT", "Authorization password is incorrect");
  }

  const token = randomBytes(32).toString("base64url");
  const record: StoredAuthorization = {
    version: 1,
    digest: digestToken(token),
    expiresAt: challenge.expiresAt
  };

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await unlink(authorizationPath(directory, confirmationId)).catch(() => undefined);
  await writeFile(authorizationPath(directory, confirmationId), JSON.stringify(record), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  return token;
}

export async function prepareUserAuthorization(
  confirmationId: string,
  password: string,
  expiresAt: number,
  options: AuthorizationOptions = {}
): Promise<void> {
  assertConfirmationId(confirmationId);
  const directory = options.directory ?? defaultAuthorizationDirectory();
  const salt = randomBytes(16).toString("hex");
  const challenge: StoredChallenge = {
    version: 1,
    salt,
    passwordDigest: derivePasswordDigest(password, salt).toString("hex"),
    expiresAt
  };

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(challengePath(directory, confirmationId), JSON.stringify(challenge), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
}

export async function consumeUserAuthorization(
  confirmationId: string,
  token: string,
  options: AuthorizationOptions = {}
): Promise<boolean> {
  if (!CONFIRMATION_ID_PATTERN.test(confirmationId) || !USER_TOKEN_PATTERN.test(token)) {
    return false;
  }

  const directory = options.directory ?? defaultAuthorizationDirectory();
  const filePath = authorizationPath(directory, confirmationId);
  let record: StoredAuthorization;
  try {
    record = parseStoredAuthorization(await readFile(filePath, "utf8"));
  } catch {
    return false;
  }

  if (record.expiresAt <= (options.now ?? Date.now)()) {
    await removeAuthorizationFiles(directory, confirmationId);
    return false;
  }

  const actualDigest = Buffer.from(digestToken(token), "hex");
  const expectedDigest = Buffer.from(record.digest, "hex");
  if (actualDigest.length !== expectedDigest.length || !timingSafeEqual(actualDigest, expectedDigest)) {
    return false;
  }

  try {
    await unlink(filePath);
  } catch {
    return false;
  }
  await unlink(challengePath(directory, confirmationId)).catch(() => undefined);
  return true;
}

function defaultAuthorizationDirectory(): string {
  return path.join(os.homedir(), ".mcp-database-service", "authorizations");
}

function authorizationPath(directory: string, confirmationId: string): string {
  return path.join(directory, `${confirmationId}.json`);
}

function challengePath(directory: string, confirmationId: string): string {
  return path.join(directory, `${confirmationId}.challenge.json`);
}

function assertConfirmationId(confirmationId: string): void {
  if (!CONFIRMATION_ID_PATTERN.test(confirmationId)) {
    throw new ApplicationError("INVALID_ARGUMENT", "Invalid confirmation identifier");
  }
}

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function derivePasswordDigest(password: string, salt: string): Buffer {
  return scryptSync(password, salt, 32);
}

async function readChallenge(directory: string, confirmationId: string): Promise<StoredChallenge> {
  let raw: string;
  try {
    raw = await readFile(challengePath(directory, confirmationId), "utf8");
  } catch {
    throw new ApplicationError("INVALID_ARGUMENT", "Unknown or expired confirmation identifier");
  }

  const value = JSON.parse(raw) as Partial<StoredChallenge>;
  if (
    value.version !== 1 ||
    typeof value.salt !== "string" ||
    !/^[0-9a-f]{32}$/i.test(value.salt) ||
    typeof value.passwordDigest !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.passwordDigest) ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt)
  ) {
    throw new ApplicationError("INVALID_ARGUMENT", "Invalid confirmation identifier state");
  }

  return value as StoredChallenge;
}

async function removeAuthorizationFiles(directory: string, confirmationId: string): Promise<void> {
  await Promise.all([
    unlink(authorizationPath(directory, confirmationId)).catch(() => undefined),
    unlink(challengePath(directory, confirmationId)).catch(() => undefined)
  ]);
}

function parseStoredAuthorization(raw: string): StoredAuthorization {
  const value = JSON.parse(raw) as Partial<StoredAuthorization>;
  if (
    value.version !== 1 ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.digest) ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt)
  ) {
    throw new Error("Invalid authorization record");
  }

  return value as StoredAuthorization;
}
