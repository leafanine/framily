/**
 * GET /api/now-playing
 *
 * Returns what the account is playing right now, or the last played track.
 * Requires SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN
 * (see scripts/spotify-auth.mjs).
 *
 * The response is cached at the edge for a few seconds so polling from many
 * visitors collapses into a handful of Spotify calls.
 */

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";

let cache = { token: null, expiresAt: 0 };

function send(res, status, payload, cacheControl) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cacheControl || "no-store");
  res.end(JSON.stringify(payload));
}

async function getAccessToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  const refresh = process.env.SPOTIFY_REFRESH_TOKEN;

  if (!id || !secret || !refresh) {
    const error = new Error("Spotify credentials are not configured");
    error.code = "not_configured";
    throw error;
  }

  if (cache.token && Date.now() < cache.expiresAt - 30000) return cache.token;

  const basic = Buffer.from(id + ":" + secret).toString("base64");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + basic,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh
    })
  });

  const data = await response.json().catch(function () { return {}; });

  if (!response.ok || !data.access_token) {
    const error = new Error("Could not refresh the Spotify access token");
    error.code = "auth";
    error.detail = data;
    throw error;
  }

  cache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000
  };

  return cache.token;
}

async function call(token, path) {
  const response = await fetch(API + path, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" }
  });

  if (response.status === 204) return null;
  if (response.status === 401) {
    cache = { token: null, expiresAt: 0 };
    return null;
  }
  if (!response.ok) return null;

  return response.json().catch(function () { return null; });
}

function normalize(item, progressMs) {
  if (!item) return null;

  const images = (item.album && item.album.images) || item.images || [];
  const art = images.length ? (images[1] || images[0]).url : null;
  const artists = item.artists || (item.show ? [item.show] : []);

  return {
    title: item.name || "",
    artists: artists.map(function (artist) { return artist.name; }).filter(Boolean).join(", "),
    album: (item.album && item.album.name) || (item.show && item.show.name) || "",
    art: art,
    url: item.external_urls ? item.external_urls.spotify : null,
    durationMs: item.duration_ms || 0,
    progressMs: progressMs || 0
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { error: "method_not_allowed" });
  }

  let token;
  try {
    token = await getAccessToken();
  } catch (error) {
    const status = error.code === "not_configured" ? 503 : 502;
    return send(res, status, {
      source: "spotify",
      error: error.code || "auth"
    });
  }

  const current = await call(
    token,
    "/me/player/currently-playing?additional_types=track,episode"
  );

  if (current && current.item) {
    return send(
      res,
      200,
      {
        source: "spotify",
        playing: Boolean(current.is_playing),
        track: normalize(current.item, current.progress_ms),
        last: null
      },
      "public, s-maxage=20, stale-while-revalidate=40"
    );
  }

  const recent = await call(token, "/me/player/recently-played?limit=1");
  const lastItem = recent && recent.items && recent.items[0] ? recent.items[0].track : null;

  return send(
    res,
    200,
    {
      source: "spotify",
      playing: false,
      track: null,
      last: normalize(lastItem, 0)
    },
    "public, s-maxage=30, stale-while-revalidate=60"
  );
};
