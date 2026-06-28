/**
 * ReLink Worker v3 — Cloudflare Workers + D1
 * ─────────────────────────────────────────────
 * AUTH / PROFIL
 *   POST /auth/discord
 *   PUT  /profile        Bearer token
 *   GET  /search?q=xxx
 *   GET  /me             Bearer token
 *
 * SERVEUR MINECRAFT
 *   GET  /server         stats Pterodactyl + mcstatus.io
 *
 * CLASSEMENTS
 *   POST /stats          X-Stats-Secret → { players: [...] }
 *   GET  /leaderboard?type=kills|blocs_poses|fortune&limit=10
 */

const PANEL     = 'https://game.lordhosting.fr';
const SERVER_ID = '1798a4bf';
const MC_HOST   = 'gm1.lordhosting.fr';
const MC_PORT   = 2062;
const DISCORD_API = 'https://discord.com/api/v10';

// ── CORS ──────────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = [
    'https://elit722.github.io',
    'https://emerarudo-senso.fr',
    'https://www.emerarudo-senso.fr',
    'http://localhost',
    'http://127.0.0.1',
  ];
  const o = allowed.find(a => origin && origin.startsWith(a)) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin':  o,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Stats-Secret',
    'Access-Control-Max-Age':       '86400',
  };
}

function json(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ── JWT ───────────────────────────────────────────────────────────────────
async function signJWT(payload, secret) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const body   = btoa(JSON.stringify(payload)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const data   = `${header}.${body}`;
  const key    = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const sig    = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${data}.${sigB64}`;
}

async function verifyJWT(token, secret) {
  try {
    const [header, body, sig] = token.split('.');
    const data   = `${header}.${body}`;
    const key    = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['verify']);
    const sigBuf = Uint8Array.from(atob(sig.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
    const valid  = await crypto.subtle.verify('HMAC', key, sigBuf, new TextEncoder().encode(data));
    if (!valid) return null;
    return JSON.parse(atob(body.replace(/-/g,'+').replace(/_/g,'/')));
  } catch { return null; }
}

async function getUser(request, env) {
  const auth  = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload || payload.exp < Date.now() / 1000) return null;
  return payload;
}

// ── Pterodactyl ───────────────────────────────────────────────────────────
async function pterodactyl(path, env) {
  const r = await fetch(`${PANEL}/api/client/servers/${SERVER_ID}${path}`, {
    headers: {
      'Authorization': `Bearer ${env.PTERO_API_KEY}`,
      'Accept': 'Application/vnd.pterodactyl.v1+json',
    },
  });
  if (!r.ok) throw new Error(`Pterodactyl ${r.status}`);
  return r.json();
}

async function minecraftStatus() {
  try {
    const r = await fetch(`https://api.mcstatus.io/v2/status/java/${MC_HOST}:${MC_PORT}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!r.ok) return null;
    const data = await r.json();
    return { online: data.online, current: data.online ? data.players.online : 0, max: data.online ? data.players.max : null };
  } catch { return null; }
}

// ── Handlers AUTH ─────────────────────────────────────────────────────────
async function handleDiscordAuth(request, env, origin) {
  const { code, redirect_uri } = await request.json();
  if (!code || !redirect_uri) return json({ error: 'Paramètres manquants' }, 400, origin);

  const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code', code, redirect_uri,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) return json({
    error: tokenData.error_description || 'OAuth échoué',
    discord_error: tokenData.error, discord_message: tokenData.message,
    status: tokenRes.status, redirect_uri_recu: redirect_uri,
    client_id_present: !!env.DISCORD_CLIENT_ID, client_secret_present: !!env.DISCORD_CLIENT_SECRET,
  }, 401, origin);

  const userRes = await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
  const dc = await userRes.json();
  if (!userRes.ok) return json({ error: 'Impossible de récupérer le profil Discord' }, 401, origin);

  const avatarUrl = dc.avatar
    ? `https://cdn.discordapp.com/avatars/${dc.id}/${dc.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${parseInt(dc.discriminator || '0') % 5}.png`;

  const existing = await env.relinkdb.prepare('SELECT * FROM users WHERE discord_id = ?').bind(dc.id).first();
  if (!existing) {
    await env.relinkdb.prepare('INSERT INTO users (discord_id, pseudo, email, avatar_url) VALUES (?, ?, ?, ?)')
      .bind(dc.id, dc.username, dc.email || null, avatarUrl).run();
  } else {
    await env.relinkdb.prepare('UPDATE users SET avatar_url = ? WHERE discord_id = ?').bind(avatarUrl, dc.id).run();
  }

  const user = existing ? { ...existing, avatar_url: avatarUrl }
    : { discord_id: dc.id, pseudo: dc.username, email: dc.email || null, avatar_url: avatarUrl };

  const access_token = await signJWT(
    { discord_id: dc.id, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 },
    env.JWT_SECRET
  );
  return json({ ...user, access_token }, 200, origin);
}

async function handleUpdateProfile(request, env, origin) {
  const auth  = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token)          return json({ error: 'Token manquant' }, 401, origin);
  if (!env.JWT_SECRET) return json({ error: 'JWT_SECRET absent' }, 500, origin);

  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload)                        return json({ error: 'Token invalide' }, 401, origin);
  if (payload.exp < Date.now() / 1000) return json({ error: 'Token expiré' }, 401, origin);

  const { pseudo, email } = await request.json();
  if (!pseudo || pseudo.length < 2 || pseudo.length > 32)
    return json({ error: 'Pseudo invalide (2-32 caractères)' }, 400, origin);

  try {
    await env.relinkdb.prepare('UPDATE users SET pseudo = ?, email = ? WHERE discord_id = ?')
      .bind(pseudo.trim(), email ? email.trim() : null, payload.discord_id).run();
    return json({ ok: true, pseudo, email: email || null }, 200, origin);
  } catch(e) {
    return json({ error: 'relinkdb error: ' + e.message }, 500, origin);
  }
}

async function handleSearch(request, env, origin) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  if (q.length < 2) return json({ results: [] }, 200, origin);
  const rows = await env.relinkdb.prepare(
    'SELECT discord_id, pseudo, avatar_url FROM users WHERE pseudo LIKE ? LIMIT 20'
  ).bind(`%${q}%`).all();
  return json({ results: rows.results || [] }, 200, origin);
}

async function handleMe(request, env, origin) {
  const payload = await getUser(request, env);
  if (!payload) return json({ error: 'Non authentifié' }, 401, origin);
  const user = await env.relinkdb.prepare(
    'SELECT discord_id, pseudo, email, avatar_url FROM users WHERE discord_id = ?'
  ).bind(payload.discord_id).first();
  if (!user) return json({ error: 'Utilisateur introuvable' }, 404, origin);
  return json(user, 200, origin);
}

// ── Handler SERVEUR ───────────────────────────────────────────────────────
async function handleServer(env, origin) {
  const [info, resources, mc] = await Promise.all([
    pterodactyl('', env),
    pterodactyl('/resources', env),
    minecraftStatus(),
  ]);
  const limits = info.attributes.limits;
  const stats  = resources.attributes.resources;
  return json({
    status:  resources.attributes.current_state,
    players: { current: mc ? mc.current : null, max: mc ? mc.max : limits.feature_limits?.allocations || 50 },
    ram:     { used_mb: Math.round(stats.memory_bytes / 1024 / 1024), limit_mb: limits.memory },
    cpu_percent:   Math.round(stats.cpu_absolute * 10) / 10,
    cpu_limit:     limits.cpu || 100,
    disk_mb:       Math.round(stats.disk_bytes / 1024 / 1024),
    disk_limit_mb: limits.disk || null,
  }, 200, origin);
}

// ── Handler STATS (reçoit les données du script Python) ───────────────────
async function handlePostStats(request, env, origin) {
  // Vérification du secret partagé
  const secret = request.headers.get('X-Stats-Secret') || '';
  if (!env.STATS_SECRET || secret !== env.STATS_SECRET)
    return json({ error: 'Non autorisé' }, 401, origin);

  const { players } = await request.json();
  if (!Array.isArray(players) || players.length === 0)
    return json({ error: 'Payload invalide' }, 400, origin);

  // Upsert de chaque joueur en batch
  const stmt = env.relinkdb.prepare(
    `INSERT INTO player_stats (uuid, pseudo, kills, blocs_poses, fortune, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(uuid) DO UPDATE SET
       pseudo      = excluded.pseudo,
       kills       = excluded.kills,
       blocs_poses = excluded.blocs_poses,
       fortune     = excluded.fortune,
       updated_at  = excluded.updated_at`
  );

  const batch = players.map(p =>
    stmt.bind(p.uuid, p.pseudo, p.kills || 0, p.blocs_poses || 0, p.fortune || 0)
  );
  await env.relinkdb.batch(batch);

  return json({ ok: true, updated: players.length }, 200, origin);
}

// ── Handler LEADERBOARD ───────────────────────────────────────────────────
async function handleLeaderboard(request, env, origin) {
  const url   = new URL(request.url);
  const type  = url.searchParams.get('type') || 'kills';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 50);

  const allowed = ['kills', 'blocs_poses', 'fortune'];
  if (!allowed.includes(type)) return json({ error: 'Type invalide' }, 400, origin);

  const rows = await env.relinkdb.prepare(
    `SELECT uuid, pseudo, kills, blocs_poses, fortune, updated_at
     FROM player_stats
     ORDER BY ${type} DESC
     LIMIT ?`
  ).bind(limit).all();

  return json({
    type,
    updated_at: rows.results?.[0]?.updated_at || null,
    results: (rows.results || []).map((r, i) => ({ rank: i + 1, ...r })),
  }, 200, origin);
}

// ── Router ────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    try {
      if (request.method === 'POST' && pathname === '/auth/discord')  return await handleDiscordAuth(request, env, origin);
      if (request.method === 'PUT'  && pathname === '/profile')       return await handleUpdateProfile(request, env, origin);
      if (request.method === 'GET'  && pathname === '/search')        return await handleSearch(request, env, origin);
      if (request.method === 'GET'  && pathname === '/me')            return await handleMe(request, env, origin);
      if (request.method === 'GET'  && pathname === '/server')        return await handleServer(env, origin);
      if (request.method === 'POST' && pathname === '/stats')         return await handlePostStats(request, env, origin);
      if (request.method === 'GET'  && pathname === '/leaderboard')   return await handleLeaderboard(request, env, origin);
      return json({ error: 'Route inconnue' }, 404, origin);
    } catch(e) {
      console.error(e);
      return json({ error: e.message || 'Erreur interne' }, 500, origin);
    }
  },
};