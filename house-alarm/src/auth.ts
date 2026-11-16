// Signing in. One shared passphrase (the APP_PASSWORD secret) guards the whole
// app; a successful sign-in is remembered with a signed, expiring cookie.

const encoder = new TextEncoder();
const COOKIE = "ha_session";
const LIFETIME_S = 180 * 24 * 3600;

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function hmac(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", k, encoder.encode(message)));
}

/** Compare two secrets without leaking, through timing, how much of a guess was right. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const p = new Uint8Array(x);
  const q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i]! ^ q[i]!;
  return diff === 0;
}

// The signing key comes from the passphrase, so changing the passphrase signs everyone out.
const signingKey = (password: string) => hmac(password, "house-alarm session key v1");

export async function sessionCookie(password: string, now: number, secure: boolean): Promise<string> {
  const expires = Math.floor(now / 1000) + LIFETIME_S;
  const signature = await hmac(await signingKey(password), String(expires));
  return `${COOKIE}=${expires}.${signature}; Path=/; Max-Age=${LIFETIME_S}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearedCookie(): string {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export async function signedIn(request: Request, password: string, now: number): Promise<boolean> {
  // Scripts and other tools may send the passphrase as a bearer token instead.
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return sameSecret(bearer, password);

  const cookie = request.headers
    .get("Cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!cookie) return false;
  const dot = cookie.indexOf(".");
  const expires = Number(cookie.slice(0, dot));
  if (dot < 1 || !Number.isFinite(expires) || expires * 1000 < now) return false;
  return sameSecret(cookie.slice(dot + 1), await hmac(await signingKey(password), String(expires)));
}
