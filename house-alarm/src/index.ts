// The Worker's front door. It serves the page, checks who is asking, and hands
// everything else to the Durable Object in clock.ts.

import { clearedCookie, sessionCookie, signedIn } from "./auth";
import { json, type Env } from "./clock";
import { APPLE_TOUCH_ICON_PNG, ICON_SVG } from "./icons";
import page from "./ui.html";

export { AlarmClock } from "./clock";

const MANIFEST = {
  name: "House Alarm",
  short_name: "House Alarm",
  description: "Whole-house alarm clock for Sonos.",
  start_url: "/",
  display: "standalone",
  background_color: "#f7f4ef",
  theme_color: "#f7f4ef",
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
  ],
};

function servePage(): Response {
  // The page is one file with its script and styles inline; a per-response
  // nonce lets exactly those run and nothing else.
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return new Response(page.replaceAll("__NONCE__", nonce), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "img-src 'self' data:",
        "manifest-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Nothing here is secret: the page is an empty shell until signed in.
    if (request.method === "GET") {
      if (path === "/" || path === "/index.html") return servePage();
      if (path === "/manifest.webmanifest") {
        return new Response(JSON.stringify(MANIFEST), { headers: { "Content-Type": "application/manifest+json" } });
      }
      if (path === "/icon.svg" || path === "/favicon.ico") {
        return new Response(ICON_SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
      }
      if (path === "/apple-touch-icon.png" || path === "/apple-touch-icon-precomposed.png") {
        const bytes = Uint8Array.from(atob(APPLE_TOUCH_ICON_PNG), (c) => c.charCodeAt(0));
        return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
      }
    }

    const isApi = path.startsWith("/api/");
    const isOauth = path.startsWith("/oauth/");
    if (!isApi && !isOauth) return new Response("Not found", { status: 404 });

    // Fail closed: with no passphrase configured, nobody gets in.
    const password = env.APP_PASSWORD;
    if (!password) {
      const message = "This alarm clock has no passphrase yet. Set the APP_PASSWORD secret on the Worker, then reload.";
      return isApi ? json({ error: message, setup: true }, 503) : new Response(message, { status: 503 });
    }

    // Anything that changes state must come from our own page, not another site.
    if (request.method !== "GET") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ error: "Cross-site requests are not allowed." }, 403);
    }

    const clock = env.CLOCK.get(env.CLOCK.idFromName("house"));

    if (path === "/api/login" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { password?: unknown };
      const verdict = await clock.fetch("https://clock/internal/login", {
        method: "POST",
        body: JSON.stringify({ password: body.password, ip: request.headers.get("CF-Connecting-IP") ?? "unknown" }),
      });
      if (!verdict.ok) return verdict;
      const cookie = await sessionCookie(password, Date.now(), url.protocol === "https:");
      return json({ ok: true }, 200, { "Set-Cookie": cookie });
    }
    if (path === "/api/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": clearedCookie() });
    }

    if (!(await signedIn(request, password, Date.now()))) {
      return isOauth ? Response.redirect(`${url.origin}/`, 302) : json({ error: "Please sign in." }, 401);
    }
    return clock.fetch(request);
  },
} satisfies ExportedHandler<Env>;
