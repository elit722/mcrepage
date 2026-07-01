/**
 * ReLink Worker v5 — Cloudflare Workers + D1
 * ─────────────────────────────────────────────
 * AUTH / PROFIL
 *   POST /auth/discord
 *   PUT  /profile          Bearer token
 *   GET  /search?q=xxx
 *   GET  /me               Bearer token
 *
 * LIAISON COMPTE MINECRAFT (sans double connexion, compatible crack)  ← NOUVEAU v5
 *   POST /mc/link/request   X-Link-Secret        appelé par le plugin MC (commande /link)
 *   POST /link/confirm      Bearer token          appelé par le site (code entré par l'utilisateur)
 *
 * SERVEUR MINECRAFT
 *   GET  /server         stats Pterodactyl + mcstatus.io
 *
 * CLASSEMENTS JOUEURS
 *   POST /stats          X-Stats-Secret → { players: [...] }
 *   GET  /leaderboard?type=kills|blocs_poses|fortune&limit=10
 *
 * CLANS
 *   POST /clans-sync     X-Stats-Secret → { clans: [...] }
 *   GET  /clans
 *
 * SOUMISSIONS UNIQUES (candidature partenaire / questionnaire équipe)
 *   GET    /submission/:type        Bearer token  → { submitted: bool, at: ts|null }
 *   POST   /submission/:type        Bearer token  → marque la soumission comme faite (définitif)
 *   DELETE /submission/:type        X-Admin-Secret + ?discord_id=xxx → déblocage admin
 *   :type ∈ "partner" | "team"
 *
 * ── ADMIN + FLAGS ─────────────────────────────────────────────────────────
 *   GET  /flags                     → { sections: {...}, require_auth: bool }
 *
 *   GET    /admin/users             X-Admin-Secret  → liste paginée
 *   POST   /admin/users/:id/status  X-Admin-Secret  → { action: suspend|ban|unban|delete }
 *   GET    /admin/flags             X-Admin-Secret  → état des flags
 *   POST   /admin/flags             X-Admin-Secret  → { key, value }
 *   GET    /admin/submissions       X-Admin-Secret  → liste des soumissions
 *
 * ── MIGRATIONS D1 (à exécuter une seule fois) ─────────────────────────────
 *   ALTER TABLE player_stats ADD COLUMN dynasty TEXT;
 *
 *   CREATE TABLE IF NOT EXISTS kv_store (
 *     key        TEXT PRIMARY KEY,
 *     value      TEXT NOT NULL,
 *     updated_at TEXT
 *   );
 *
 *   CREATE TABLE IF NOT EXISTS submissions (
 *     discord_id TEXT NOT NULL,
 *     type       TEXT NOT NULL,
 *     payload    TEXT,
 *     created_at TEXT NOT NULL,
 *     PRIMARY KEY (discord_id, type)
 *   );
 *
 *   ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active';
 *
 *   CREATE TABLE IF NOT EXISTS site_flags (
 *     key        TEXT PRIMARY KEY,
 *     value      TEXT NOT NULL,
 *     updated_at TEXT
 *   );
 *
 *   INSERT OR IGNORE INTO site_flags (key, value, updated_at) VALUES
 *     ('require_auth',         'false', datetime('now')),
 *     ('section:home',         'true',  datetime('now')),
 *     ('section:modpack',      'true',  datetime('now')),
 *     ('section:lore',         'true',  datetime('now')),
 *     ('section:reglement',    'true',  datetime('now')),
 *     ('section:partenaires',  'true',  datetime('now')),
 *     ('section:ajouts',       'true',  datetime('now')),
 *     ('section:server',       'true',  datetime('now')),
 *     ('section:clans',        'true',  datetime('now')),
 *     ('section:team',         'true',  datetime('now')),
 *     ('section:about',        'true',  datetime('now')),
 *     ('section:staff',        'true',  datetime('now')),
 *     ('section:aide',         'true',  datetime('now'));
 *
 *   ALTER TABLE users ADD COLUMN minecraft_uuid     TEXT;
 *   ALTER TABLE users ADD COLUMN minecraft_username TEXT;
 *   CREATE UNIQUE INDEX IF NOT EXISTS idx_users_minecraft_uuid
 *     ON users(minecraft_uuid) WHERE minecraft_uuid IS NOT NULL;
 *
 *   -- NOUVELLE migration v5 : table des codes de liaison /link (ajout pur)
 *   CREATE TABLE IF NOT EXISTS link_codes (
 *     code        TEXT PRIMARY KEY,
 *     mc_uuid     TEXT NOT NULL,
 *     mc_username TEXT NOT NULL,
 *     created_at  INTEGER NOT NULL,
 *     expires_at  INTEGER NOT NULL,
 *     used        INTEGER NOT NULL DEFAULT 0
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_link_codes_mc_uuid ON link_codes (mc_uuid);
 *
 * ── VARIABLES / SECRETS WORKER À CONFIGURER (wrangler) ────────────────────
 *   LINK_SECRET   (secret — partagé avec le plugin Minecraft, protège /mc/link/request)
 *   wrangler secret put LINK_SECRET
 *
 *   Les secrets MS_CLIENT_ID / MS_CLIENT_SECRET ne sont plus utilisés en v5,
 *   tu peux les retirer (wrangler secret delete MS_CLIENT_SECRET).
 * ──────────────────────────────────────────────────────────────────────────
 */

const PANEL       = 'https://game.lordhosting.fr';
const SERVER_ID   = '1798a4bf';
const MC_HOST     = 'gm1.lordhosting.fr';
const MC_PORT     = 2062;
const DISCORD_API = 'https://discord.com/api/v10';

// Durée de validité d'un code /link (en millisecondes)
const LINK_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Types de soumission unique autorisés (cf. table `submissions`)
const SUBMISSION_TYPES = ['partner', 'team'];

// Sections gérées par les flags
const SITE_SECTIONS = ['home', 'modpack', 'lore', 'reglement', 'partenaires', 'ajouts', 'server', 'clans', 'team', 'about', 'staff', 'aide'];

// ── CORS ──────────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = [
    'https://elit722.github.io',
    'https://emerarudo-senso.fr',
    'https://www.emerarudo-senso.fr',
    'http://localhost',
    'http://127.0.0.1',
    'null', // admin.html ouvert en file:// depuis le bureau
  ];
  const o = (origin === 'null' || allowed.find(a => origin && origin.startsWith(a))) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin':  o,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Stats-Secret,X-Admin-Secret,X-Link-Secret',
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
  // Bloquer la connexion si le compte est banni ou suspendu
  if (existing) {
    if (existing.status === 'banned')    return json({ error: 'Compte banni' }, 403, origin);
    if (existing.status === 'suspended') return json({ error: 'Compte suspendu' }, 403, origin);
  }
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
  // is_new_user : indique au front qu'il faut déclencher l'étape de liaison
  // du compte Minecraft — désormais via /link en jeu, plus via Microsoft.
  return json({ ...user, access_token, is_new_user: !existing }, 200, origin);
}

// ── NOUVEAU v5 : liaison du compte Minecraft via code /link (crack-compatible) ──

function generateLinkCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Appelé par le plugin Minecraft (serveur -> Worker) quand un joueur tape /link.
 * Protégé par un secret partagé (X-Link-Secret), pas par une session Discord :
 * c'est le serveur MC qui parle au Worker, pas le joueur directement.
 */
async function handleLinkRequest(request, env, origin) {
  console.log("===== HEADERS =====");

for (const [k, v] of request.headers.entries()) {
  console.log(`${k.toLowerCase()} = ${v}`);
}

const secret = request.headers.get("X-Link-Secret")
  || request.headers.get("x-link-secret");

console.log("SECRET RECEIVED =", secret);
console.log("SECRET ENV =", env.LINK_SECRET);

if (!env.LINK_SECRET || !secret || secret !== env.LINK_SECRET) {
  return json({
    error: "Non autorisé",
    debug: {
      received: secret,
      expected: env.LINK_SECRET
    }
  }, 401, origin);
}

  const { mc_uuid, mc_username } = await request.json();
  if (!mc_uuid || !mc_username) return json({ error: 'Paramètres manquants' }, 400, origin);

  const code = generateLinkCode();
  const now = Date.now();
  const expiresAt = now + LINK_CODE_TTL_MS;

  // On invalide les anciens codes en attente pour ce joueur
  await env.relinkdb.prepare('DELETE FROM link_codes WHERE mc_uuid = ?').bind(mc_uuid).run();

  await env.relinkdb.prepare(
    `INSERT INTO link_codes (code, mc_uuid, mc_username, created_at, expires_at, used)
     VALUES (?, ?, ?, ?, ?, 0)`
  ).bind(code, mc_uuid, mc_username, now, expiresAt).run();

  return json({ code, expires_in: Math.floor(LINK_CODE_TTL_MS / 1000) }, 200, origin);
}

/**
 * Appelé depuis le site par un utilisateur déjà connecté à Discord (Bearer token),
 * qui entre le code affiché en jeu par /link.
 */
async function handleLinkConfirm(request, env, origin) {
  const payload = await getUser(request, env);
  if (!payload) return json({ error: 'Non authentifié' }, 401, origin);

  const { code } = await request.json();
  if (!code) return json({ error: 'Code manquant' }, 400, origin);

  const row = await env.relinkdb.prepare(
    'SELECT * FROM link_codes WHERE code = ? AND used = 0'
  ).bind(String(code).trim()).first();

  if (!row) return json({ error: 'Code invalide' }, 400, origin);
  if (Date.now() > row.expires_at) return json({ error: 'Code expiré, régénère-le avec /link en jeu' }, 400, origin);

  // Vérifie que ce compte Minecraft n'est pas déjà lié à un AUTRE compte Discord
  const conflict = await env.relinkdb.prepare(
    'SELECT discord_id FROM users WHERE minecraft_uuid = ? AND discord_id != ?'
  ).bind(row.mc_uuid, payload.discord_id).first();
  if (conflict) return json({ error: 'Ce compte Minecraft est déjà lié à un autre profil.' }, 409, origin);

  await env.relinkdb.batch([
    env.relinkdb.prepare('UPDATE link_codes SET used = 1 WHERE code = ?').bind(row.code),
    env.relinkdb.prepare('UPDATE users SET minecraft_uuid = ?, minecraft_username = ? WHERE discord_id = ?')
      .bind(row.mc_uuid, row.mc_username, payload.discord_id),
  ]);

  return json({ ok: true, minecraft_uuid: row.mc_uuid, minecraft_username: row.mc_username }, 200, origin);
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
    'SELECT discord_id, pseudo, avatar_url, minecraft_uuid, minecraft_username FROM users WHERE pseudo LIKE ? LIMIT 20'
  ).bind(`%${q}%`).all();
  return json({ results: rows.results || [] }, 200, origin);
}

async function handleMe(request, env, origin) {
  const payload = await getUser(request, env);
  if (!payload) return json({ error: 'Non authentifié' }, 401, origin);
  const user = await env.relinkdb.prepare(
    'SELECT discord_id, pseudo, email, avatar_url, status, minecraft_uuid, minecraft_username FROM users WHERE discord_id = ?'
  ).bind(payload.discord_id).first();
  if (!user) return json({ error: 'Utilisateur introuvable' }, 404, origin);
  // Vérification statut — permet au site de détecter suspension/ban au rechargement
  if (user.status === 'banned')    return json({ error: 'Compte banni' }, 403, origin);
  if (user.status === 'suspended') return json({ error: 'Compte suspendu' }, 401, origin);
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

// ── Handler STATS joueurs (reçoit les données du script Python) ───────────
async function handlePostStats(request, env, origin) {
  const secret = request.headers.get('X-Stats-Secret') || '';
  if (!env.STATS_SECRET || secret !== env.STATS_SECRET)
    return json({ error: 'Non autorisé' }, 401, origin);

  const { players } = await request.json();
  if (!Array.isArray(players) || players.length === 0)
    return json({ error: 'Payload invalide' }, 400, origin);

  const stmt = env.relinkdb.prepare(
    `INSERT INTO player_stats (uuid, pseudo, kills, blocs_poses, fortune, dynasty, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(uuid) DO UPDATE SET
       pseudo      = excluded.pseudo,
       kills       = excluded.kills,
       blocs_poses = excluded.blocs_poses,
       fortune     = excluded.fortune,
       dynasty     = excluded.dynasty,
       updated_at  = excluded.updated_at`
  );

  const batch = players.map(p =>
    stmt.bind(p.uuid, p.pseudo, p.kills || 0, p.blocs_poses || 0, p.fortune || 0, p.dynasty || null)
  );
  await env.relinkdb.batch(batch);

  return json({ ok: true, updated: players.length }, 200, origin);
}

// ── Handler LEADERBOARD joueurs ───────────────────────────────────────────
async function handleLeaderboard(request, env, origin) {
  const url   = new URL(request.url);
  const type  = url.searchParams.get('type') || 'kills';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 50);

  const allowed = ['kills', 'blocs_poses', 'fortune'];
  if (!allowed.includes(type)) return json({ error: 'Type invalide' }, 400, origin);

  const rows = await env.relinkdb.prepare(
    `SELECT ps.uuid, ps.pseudo, ps.kills, ps.blocs_poses, ps.fortune, ps.dynasty, ps.updated_at,
            u.avatar_url
     FROM player_stats ps
     LEFT JOIN users u ON LOWER(u.pseudo) = LOWER(ps.pseudo)
     ORDER BY ps.${type} DESC
     LIMIT ?`
  ).bind(limit).all();

  return json({
    type,
    updated_at: rows.results?.[0]?.updated_at || null,
    results: (rows.results || []).map((r, i) => ({ rank: i + 1, ...r })),
  }, 200, origin);
}

// ── Handler CLANS — sync (reçoit les données du script Python) ────────────
async function handlePostClans(request, env, origin) {
  const secret = request.headers.get('X-Stats-Secret') || '';
  if (!env.STATS_SECRET || secret !== env.STATS_SECRET)
    return json({ error: 'Non autorisé' }, 401, origin);

  const { clans } = await request.json();
  if (!Array.isArray(clans) || clans.length === 0)
    return json({ error: 'Payload invalide' }, 400, origin);

  await env.relinkdb.prepare(
    `INSERT INTO kv_store (key, value, updated_at)
     VALUES ('clans', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value      = excluded.value,
       updated_at = excluded.updated_at`
  ).bind(JSON.stringify(clans)).run();

  return json({ ok: true, updated: clans.length }, 200, origin);
}

// ── Handler CLANS — lecture (site web) ───────────────────────────────────
async function handleGetClans(request, env, origin) {
  const row = await env.relinkdb.prepare(
    `SELECT value, updated_at FROM kv_store WHERE key = 'clans'`
  ).first();
  if (!row) return json([], 200, origin);
  return json(JSON.parse(row.value), 200, origin);
}

// ── Handlers SOUMISSIONS UNIQUES (partenaire / équipe) ────────────────────
function extractSubmissionType(pathname) {
  const m = pathname.match(/^\/submission\/([a-z]+)$/);
  if (!m) return null;
  const type = m[1];
  return SUBMISSION_TYPES.includes(type) ? type : null;
}

async function handleGetSubmission(request, env, origin, type) {
  const payload = await getUser(request, env);
  if (!payload) return json({ error: 'Non authentifié' }, 401, origin);

  const row = await env.relinkdb.prepare(
    'SELECT created_at FROM submissions WHERE discord_id = ? AND type = ?'
  ).bind(payload.discord_id, type).first();

  return json({ submitted: !!row, at: row ? row.created_at : null }, 200, origin);
}

async function handlePostSubmission(request, env, origin, type) {
  const payload = await getUser(request, env);
  if (!payload) return json({ error: 'Non authentifié' }, 401, origin);

  const existing = await env.relinkdb.prepare(
    'SELECT created_at FROM submissions WHERE discord_id = ? AND type = ?'
  ).bind(payload.discord_id, type).first();

  if (existing) {
    return json({ error: 'Déjà soumis', submitted: true, at: existing.created_at }, 409, origin);
  }

  let body = {};
  try { body = await request.json(); } catch { /* corps optionnel */ }
  const payloadStr = body && Object.keys(body).length ? JSON.stringify(body).slice(0, 8000) : null;

  try {
    await env.relinkdb.prepare(
      `INSERT INTO submissions (discord_id, type, payload, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).bind(payload.discord_id, type, payloadStr).run();
  } catch(e) {
    return json({ error: 'Déjà soumis', submitted: true }, 409, origin);
  }

  return json({ ok: true, submitted: true }, 200, origin);
}

async function handleDeleteSubmission(request, env, origin, type) {
  const secret = request.headers.get('X-Admin-Secret') || '';
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET)
    return json({ error: 'Non autorisé' }, 401, origin);

  const discordId = new URL(request.url).searchParams.get('discord_id');
  if (!discordId) return json({ error: 'discord_id manquant' }, 400, origin);

  await env.relinkdb.prepare(
    'DELETE FROM submissions WHERE discord_id = ? AND type = ?'
  ).bind(discordId, type).run();

  return json({ ok: true, unlocked: discordId, type }, 200, origin);
}

// ════════════════════════════════════════════════════════════════════════════
// HANDLERS ADMIN + FLAGS (inchangés)
// ════════════════════════════════════════════════════════════════════════════

function checkAdmin(request, env) {
  const secret = request.headers.get('X-Admin-Secret') || '';
  return env.ADMIN_SECRET && secret === env.ADMIN_SECRET;
}

// ── GET /flags — lecture publique pour le site principal ──────────────────
async function handleGetFlags(env, origin) {
  const rows = await env.relinkdb.prepare(
    'SELECT key, value FROM site_flags'
  ).all();

  const flags = { sections: {}, require_auth: false };
  for (const row of (rows.results || [])) {
    if (row.key === 'require_auth') {
      flags.require_auth = row.value === 'true';
    } else if (row.key.startsWith('section:')) {
      flags.sections[row.key.replace('section:', '')] = row.value === 'true';
    }
  }
  for (const s of SITE_SECTIONS) {
    if (!(s in flags.sections)) flags.sections[s] = true;
  }
  return json(flags, 200, origin);
}

// ── GET /admin/users ───────────────────────────────────────────────────────
async function handleAdminGetUsers(request, env, origin) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);

  const url    = new URL(request.url);
  const q      = url.searchParams.get('q') || '';
  const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const base = `
    SELECT u.discord_id, u.pseudo, u.email, u.avatar_url, u.status,
      u.minecraft_uuid, u.minecraft_username,
      (SELECT created_at FROM submissions s WHERE s.discord_id = u.discord_id AND s.type='partner' LIMIT 1) AS submitted_partner,
      (SELECT created_at FROM submissions s WHERE s.discord_id = u.discord_id AND s.type='team'    LIMIT 1) AS submitted_team
    FROM users u`;

  let rows, total;
  if (q.length >= 2) {
    rows  = await env.relinkdb.prepare(base + ' WHERE u.pseudo LIKE ? ORDER BY u.pseudo LIMIT ? OFFSET ?').bind(`%${q}%`, limit, offset).all();
    total = await env.relinkdb.prepare('SELECT COUNT(*) AS n FROM users WHERE pseudo LIKE ?').bind(`%${q}%`).first();
  } else {
    rows  = await env.relinkdb.prepare(base + ' ORDER BY u.pseudo LIMIT ? OFFSET ?').bind(limit, offset).all();
    total = await env.relinkdb.prepare('SELECT COUNT(*) AS n FROM users').first();
  }

  return json({ users: rows.results || [], total: total?.n || 0 }, 200, origin);
}

// ── POST /admin/users/:discord_id/status ──────────────────────────────────
async function handleAdminUserStatus(request, env, origin, discordId) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);

  const { action } = await request.json();
  if (!['suspend', 'ban', 'unban', 'delete'].includes(action))
    return json({ error: 'Action invalide' }, 400, origin);

  const user = await env.relinkdb.prepare('SELECT discord_id, pseudo FROM users WHERE discord_id = ?').bind(discordId).first();
  if (!user) return json({ error: 'Utilisateur introuvable' }, 404, origin);

  if (action === 'delete') {
    await env.relinkdb.batch([
      env.relinkdb.prepare('DELETE FROM users       WHERE discord_id = ?').bind(discordId),
      env.relinkdb.prepare('DELETE FROM submissions WHERE discord_id = ?').bind(discordId),
    ]);
    return json({ ok: true, action: 'deleted', discord_id: discordId }, 200, origin);
  }

  const statusMap = { suspend: 'suspended', ban: 'banned', unban: 'active' };
  await env.relinkdb.prepare('UPDATE users SET status = ? WHERE discord_id = ?')
    .bind(statusMap[action], discordId).run();

  return json({ ok: true, action, new_status: statusMap[action], discord_id: discordId, pseudo: user.pseudo }, 200, origin);
}

// ── GET /admin/flags ───────────────────────────────────────────────────────
async function handleAdminGetFlags(request, env, origin) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);
  return handleGetFlags(env, origin);
}

// ── POST /admin/flags ──────────────────────────────────────────────────────
async function handleAdminSetFlag(request, env, origin) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);

  const { key, value } = await request.json();
  const allowed = ['flag:require_auth', ...SITE_SECTIONS.map(s => `flag:section:${s}`)];
  if (!allowed.includes(key)) return json({ error: 'Clé invalide', received: key, allowed }, 400, origin);
  const storageKey = key.replace(/^flag:/, '');

  await env.relinkdb.prepare(
    `INSERT INTO site_flags (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(storageKey, String(value)).run();

  return json({ ok: true, key, value: String(value) }, 200, origin);
}

// ── GET /admin/submissions ─────────────────────────────────────────────────
async function handleAdminGetSubmissions(request, env, origin) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);

  const type = new URL(request.url).searchParams.get('type');
  let rows;
  if (type && SUBMISSION_TYPES.includes(type)) {
    rows = await env.relinkdb.prepare(
      `SELECT s.discord_id, s.type, s.created_at, u.pseudo, u.avatar_url
       FROM submissions s LEFT JOIN users u ON u.discord_id = s.discord_id
       WHERE s.type = ? ORDER BY s.created_at DESC`
    ).bind(type).all();
  } else {
    rows = await env.relinkdb.prepare(
      `SELECT s.discord_id, s.type, s.created_at, u.pseudo, u.avatar_url
       FROM submissions s LEFT JOIN users u ON u.discord_id = s.discord_id
       ORDER BY s.created_at DESC`
    ).all();
  }
  return json({ submissions: rows.results || [] }, 200, origin);
}

// ── Router ────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    try {
      // ── Routes existantes ─────────────────────────────────────────────────
      if (request.method === 'POST' && pathname === '/auth/discord')   return await handleDiscordAuth(request, env, origin);
      if (request.method === 'PUT'  && pathname === '/profile')       return await handleUpdateProfile(request, env, origin);
      if (request.method === 'GET'  && pathname === '/search')        return await handleSearch(request, env, origin);
      if (request.method === 'GET'  && pathname === '/me')            return await handleMe(request, env, origin);
      if (request.method === 'GET'  && pathname === '/server')        return await handleServer(env, origin);
      if (request.method === 'POST' && pathname === '/stats')         return await handlePostStats(request, env, origin);
      if (request.method === 'GET'  && pathname === '/leaderboard')   return await handleLeaderboard(request, env, origin);
      if (request.method === 'POST' && pathname === '/clans-sync')    return await handlePostClans(request, env, origin);
      if (request.method === 'GET'  && pathname === '/clans')         return await handleGetClans(request, env, origin);

      // ── NOUVEAU v5 : liaison compte Minecraft via /link ──────────────────
      if (request.method === 'POST' && pathname === '/mc/link/request') return await handleLinkRequest(request, env, origin);
      if (request.method === 'POST' && pathname === '/link/confirm')    return await handleLinkConfirm(request, env, origin);

      const submissionType = extractSubmissionType(pathname);
      if (submissionType) {
        if (request.method === 'GET')    return await handleGetSubmission(request, env, origin, submissionType);
        if (request.method === 'POST')   return await handlePostSubmission(request, env, origin, submissionType);
        if (request.method === 'DELETE') return await handleDeleteSubmission(request, env, origin, submissionType);
      }

      // ── Routes admin / flags ──────────────────────────────────────────────
      if (request.method === 'GET'  && pathname === '/flags')              return await handleGetFlags(env, origin);
      if (request.method === 'GET'  && pathname === '/admin/users')        return await handleAdminGetUsers(request, env, origin);
      if (request.method === 'GET'  && pathname === '/admin/flags')        return await handleAdminGetFlags(request, env, origin);
      if (request.method === 'POST' && pathname === '/admin/flags')        return await handleAdminSetFlag(request, env, origin);
      if (request.method === 'GET'  && pathname === '/admin/submissions')  return await handleAdminGetSubmissions(request, env, origin);

      const adminUserMatch = pathname.match(/^\/admin\/users\/([^/]+)\/status$/);
      if (adminUserMatch && request.method === 'POST')
        return await handleAdminUserStatus(request, env, origin, adminUserMatch[1]);

      return json({ error: 'Route inconnue' }, 404, origin);
    } catch(e) {
      console.error(e);
      return json({ error: e.message || 'Erreur interne' }, 500, origin);
    }
  },
};