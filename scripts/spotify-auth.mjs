#!/usr/bin/env node
/**
 * One-time Spotify authorization.
 *
 *   1. Put SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.local
 *   2. node scripts/spotify-auth.mjs
 *   3. Log in, approve. The refresh token is printed and written to .env.local
 *
 * The redirect URI must match one saved in the Spotify dashboard, character
 * for character. Override with SPOTIFY_REDIRECT_URI if you saved the
 * localhost form instead of 127.0.0.1.
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { exec } from "node:child_process";

const HOST = "127.0.0.1";
const PORT = 8888;
const SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-read-recently-played"
].join(" ");

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function openBrowser(url) {
  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, () => {});
}

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#060607;color:#dcdcdc;
    font:14px/1.7 ui-monospace,"Cascadia Mono",Consolas,monospace}
  main{max-width:560px;padding:32px;border:1px solid #23262b}
  h1{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#ff3b3b;margin:0 0 14px}
  code,pre{background:#0b0c0f;border:1px solid #23262b;padding:2px 6px;font:inherit}
  pre{padding:12px;overflow:auto}
  p{margin:0 0 12px;color:#c2c2c6}
</style>
<main><h1>${title}</h1>${body}</main>`;
}

const fileEnv = loadEnvFile(".env.local");
const clientId = (process.env.SPOTIFY_CLIENT_ID || fileEnv.SPOTIFY_CLIENT_ID || "").trim();
const clientSecret = (process.env.SPOTIFY_CLIENT_SECRET || fileEnv.SPOTIFY_CLIENT_SECRET || "").trim();
const redirectUri = (
  process.env.SPOTIFY_REDIRECT_URI ||
  fileEnv.SPOTIFY_REDIRECT_URI ||
  `http://${HOST}:${PORT}/callback`
).trim();

if (!clientId || !clientSecret) {
  console.error(
    "\nMissing credentials.\n\nCreate .env.local next to index.html with:\n\n" +
      "  SPOTIFY_CLIENT_ID=your_client_id\n" +
      "  SPOTIFY_CLIENT_SECRET=your_client_secret\n\n" +
      "Optionally, if your dashboard callback uses localhost rather than 127.0.0.1:\n\n" +
      "  SPOTIFY_REDIRECT_URI=http://localhost:8888/callback\n"
  );
  process.exit(1);
}

const redirectPath = new URL(redirectUri).pathname;
const state = randomBytes(16).toString("hex");

const authUrl =
  "https://accounts.spotify.com/authorize?" +
  new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    show_dialog: "true"
  }).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);

  if (url.pathname !== redirectPath) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }

  const send = (status, html) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  };

  const denied = url.searchParams.get("error");
  if (denied) {
    send(400, page("authorization failed", `<p>Spotify returned <code>${denied}</code>.</p>`));
    console.error(`\nSpotify returned: ${denied}\n`);
    server.close();
    process.exitCode = 1;
    return;
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");

  if (!code) {
    send(400, page("authorization failed", "<p>No authorization code in the callback.</p>"));
    server.close();
    process.exitCode = 1;
    return;
  }

  if (returnedState !== state) {
    send(400, page("authorization failed", "<p>State mismatch. Start the script again.</p>"));
    console.error("\nState mismatch - possible stray request. Run the script again.\n");
    server.close();
    process.exitCode = 1;
    return;
  }

  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
      })
    });

    const data = await response.json();

    if (!response.ok || !data.refresh_token) {
      send(
        400,
        page("token exchange failed", `<pre>${JSON.stringify(data, null, 2)}</pre>`)
      );
      console.error("\nToken exchange failed:\n" + JSON.stringify(data, null, 2) + "\n");
      server.close();
      process.exitCode = 1;
      return;
    }

    const lines = [
      "# generated by scripts/spotify-auth.mjs - never commit this file",
      `SPOTIFY_CLIENT_ID=${clientId}`,
      `SPOTIFY_CLIENT_SECRET=${clientSecret}`,
      `SPOTIFY_REFRESH_TOKEN=${data.refresh_token}`
    ];
    if (redirectUri !== `http://${HOST}:${PORT}/callback`) {
      lines.push(`SPOTIFY_REDIRECT_URI=${redirectUri}`);
    }
    writeFileSync(".env.local", lines.join("\n") + "\n", "utf8");

    console.log("\n  authorized. refresh token:\n");
    console.log("  " + data.refresh_token + "\n");
    console.log("  written to .env.local (gitignored)");
    console.log("  scopes granted: " + (data.scope || SCOPES) + "\n");
    console.log("  next: copy these three values into Vercel -> Settings -> Environment Variables\n");

    send(
      200,
      page(
        "linked",
        "<p>The terminal is authorized. You can close this tab.</p>" +
          "<p>Your refresh token is in <code>.env.local</code> and was printed in your terminal.</p>"
      )
    );
    server.close();
  } catch (error) {
    send(500, page("error", `<pre>${String(error && error.message ? error.message : error)}</pre>`));
    console.error("\n" + (error && error.stack ? error.stack : error) + "\n");
    server.close();
    process.exitCode = 1;
  }
});

server.listen(PORT, HOST, () => {
  console.log("\n  redirect uri: " + redirectUri);
  console.log("  if Spotify says 'invalid redirect URI', this string must match the dashboard exactly\n");
  console.log("  open this if the browser does not:\n\n  " + authUrl + "\n");
  openBrowser(authUrl);
});
