// Type declarations for auth-shared.js (vendored into TS workers).

export interface SessionClaims {
  iss: string;
  sub: string;
  hh: string;
  em?: string;
  role?: "owner" | "member";
  jti: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export function sha256Hex(text: string): Promise<string>;
export function randomToken(bytes?: number): string;
export function randomCode(digits?: number): string;
export function timingSafeEqual(a: string, b: string): boolean;
export function signSessionJwt(claims: SessionClaims, secret: string): Promise<string>;
export function verifySessionJwt(
  jwt: string,
  secrets: string | Array<string | undefined>,
  opts?: { now?: number; skewSec?: number; iss?: string }
): Promise<SessionClaims | null>;
export function decodeJwtClaims(jwt: string): SessionClaims | null;
