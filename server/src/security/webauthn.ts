import type { Request } from "express";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
import type { RegistrationResponseJSON, AuthenticationResponseJSON, WebAuthnCredential } from "@simplewebauthn/server";
import type { Settings } from "../config.ts";

const RP_NAME = "FileUpload";

/** Derives rpID/expectedOrigin from the request itself (this app is
 * same-origin only, no CORS -- see app.ts), rather than a static config
 * value, since @simplewebauthn's verify calls take these per-call. When
 * ALLOWED_HOSTS is configured, the derived host must be in that list. */
export function resolveRpContext(settings: Settings, req: Request): { rpID: string; origin: string } {
  const originHeader = req.header("origin");
  const host = req.header("host") ?? "localhost";
  const proto = req.protocol;
  const origin = originHeader || `${proto}://${host}`;
  const rpID = new URL(origin).hostname;

  const allowedHosts = settings.allowedHosts
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (allowedHosts.length > 0 && !allowedHosts.includes(rpID)) {
    throw new Error(`origin ${origin} not in ALLOWED_HOSTS`);
  }
  return { rpID, origin };
}

interface RegistrationChallengeEntry {
  challenge: string;
  expiresAt: number;
}

const registrationChallenges = new Map<string, RegistrationChallengeEntry>();
const REGISTRATION_TTL_MS = 2 * 60 * 1000;

function sweepRegistrationChallenges(): void {
  const now = Date.now();
  for (const [sessionId, entry] of registrationChallenges) {
    if (entry.expiresAt <= now) registrationChallenges.delete(sessionId);
  }
}

export async function buildRegistrationOptions(
  rpContext: { rpID: string },
  sessionId: string,
  userHandle: string,
  username: string,
  excludeCredentialIds: string[],
) {
  sweepRegistrationChallenges();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpContext.rpID,
    userName: username,
    userID: Buffer.from(userHandle, "base64url"),
    excludeCredentials: excludeCredentialIds.map((id) => ({ id })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  registrationChallenges.set(sessionId, { challenge: options.challenge, expiresAt: Date.now() + REGISTRATION_TTL_MS });
  return options;
}

export function takeRegistrationChallenge(sessionId: string): string | null {
  sweepRegistrationChallenges();
  const entry = registrationChallenges.get(sessionId);
  registrationChallenges.delete(sessionId);
  return entry?.challenge ?? null;
}

export async function verifyRegistration(
  rpContext: { rpID: string; origin: string },
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rpContext.origin,
    expectedRPID: rpContext.rpID,
    requireUserVerification: false,
  });
}

export async function buildAuthenticationOptions(rpContext: { rpID: string }) {
  return generateAuthenticationOptions({
    rpID: rpContext.rpID,
    userVerification: "preferred",
  });
}

export async function verifyAuthentication(
  rpContext: { rpID: string; origin: string },
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  credential: WebAuthnCredential,
): Promise<VerifiedAuthenticationResponse> {
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rpContext.origin,
    expectedRPID: rpContext.rpID,
    credential,
    requireUserVerification: false,
  });
}
