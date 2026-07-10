/**
 * ReLink Worker v6 — Cloudflare Workers + D1
 * ─────────────────────────────────────────────
 * AUTH / PROFIL
 *   POST /auth/discord
 *   PUT  /profile          Bearer token
 *   GET  /search?q=xxx
 *   GET  /me               Bearer token
 *
 * LIAISON COMPTE MINECRAFT (sans double connexion, compatible crack)
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
 * FORMULAIRES → DISCORD (NOUVEAU v6)                                   ← NOUVEAU
 *   POST /forms/:type    → relaie vers le webhook Discord correspondant.
 *   Le webhook n'est JAMAIS exposé côté client : il vit uniquement dans
 *   les secrets du Worker. Rate limit serveur + honeypot anti-bot inclus.
 *   :type ∈ clés de FORM_TYPES (ex: "aide")
 *
 * ── ADMIN + FLAGS ─────────────────────────────────────────────────────────
 *   GET  /flags                     → { sections: {...}, require_auth: bool }
 *
 *   GET    /admin/users                 X-Admin-Secret  → liste paginée
 *   POST   /admin/users/:id/status      X-Admin-Secret  → { action: suspend|ban|unban|delete }
 *   POST   /admin/users/:id/force-link  X-Admin-Secret  → { mc_uuid, mc_username } — lie/relie de force
 *   GET    /admin/flags             X-Admin-Secret  → état des flags
 *   POST   /admin/flags             X-Admin-Secret  → { key, value }
 *   GET    /admin/submissions       X-Admin-Secret  → liste des soumissions
 *
 * ── SYSTÈME D'ÉCLATS — ADMIN (NOUVEAU v9) ─────────────────────────────────  ← NOUVEAU
 *   POST   /admin/eclats/grant      X-Admin-Secret  → { discord_id, amount, reason? }
 *          amount peut être négatif (retrait). reason par défaut : admin_grant / admin_remove.
 *   POST   /admin/eclats/partner    X-Admin-Secret  → { discord_id, is_partner, partner_bonus_percent, apply_bonus? }
 *          apply_bonus (optionnel) crédite directement un montant d'éclats (ex: bonus d'entrée en partenariat).
 *   GET    /admin/shop              X-Admin-Secret  → tous les articles boutique (visibles ou non)
 *   POST   /admin/shop              X-Admin-Secret  → crée un article
 *   PUT    /admin/shop/:id          X-Admin-Secret  → modifie un article (prix, visible, achetable, quantités, promo...)
 *   DELETE /admin/shop/:id          X-Admin-Secret  → supprime un article
 *   POST   /admin/shop/:id/grant    X-Admin-Secret  → { discord_id, quantity } — offre l'article gratuitement à un membre
 *   GET    /shop                                    → articles visibles (site public)
 *
 * ── SYSTÈME D'ÉCLATS — SITE (NOUVEAU v10) ─────────────────────────────────  ← NOUVEAU
 *   GET  /rewards/summary        Bearer token  → { eclats, is_partner, partner_bonus_percent,
 *                                                   referral_code, referral_count, referral_status, streak }
 *        (génère le code de parrainage à la volée s'il n'existe pas encore)
 *   POST /referral/redeem        Bearer token  → { code } — applique le code d'un parrain
 *        (NOUVEAU v11 : n'est plus la voie principale, cf. /link/confirm ci-dessous —
 *        conservé pour compat / rattrapage, mais la saisie se fait normalement à la liaison MC)
 *   GET  /leaderboard/referrals?limit=10         → top parrains (public)
 *   GET  /leaderboard/streak?limit=10            → top streaks en cours (public)
 *   POST /shop/:id/purchase      Bearer token  → { quantity? } — achat réel, débite les éclats
 *   GET  /shop/purchases/me      Bearer token  → historique d'achats du joueur connecté
 *
 * ── NOUVEAU v11 : PARRAINAGE À LA LIAISON MC + PALIER 2H DE JEU ───────────
 *   Le code de parrainage se saisit désormais dans la modale de liaison
 *   Minecraft (/link), en même temps que le code à 6 chiffres — plus besoin
 *   d'y revenir après coup sur la page Récompenses.
 *   POST /link/confirm accepte donc désormais un champ optionnel `referral_code`.
 *
 *   Récompense différée : le parrainage est enregistré tout de suite
 *   (referrals.validated = 0, reward_given = 0) mais les Éclats ne sont
 *   crédités (au parrain ET au filleul) que lorsque le FILLEUL cumule au
 *   moins REFERRAL_MIN_PLAYTIME_SECONDS (2h) de temps de jeu. Ce cumul est
 *   lu depuis users.total_playtime_seconds, alimenté par /stats (le pipeline
 *   / mod encore à connecter), et vérifié à chaque mise à jour de stats.
 *
 * ── ADMIN — SUIVI DES COMMANDES BOUTIQUE (NOUVEAU v11) ─────────────────────
 *   GET  /admin/shop/purchases                X-Admin-Secret  → { purchases, total }
 *        ?status=pending|fulfilled|cancelled  (optionnel) &limit=&offset=
 *   POST /admin/shop/purchases/:id/status     X-Admin-Secret  → { status: pending|fulfilled|cancelled }
 *   DELETE /admin/shop/purchases/:id          X-Admin-Secret  → supprime une commande précise (NOUVEAU v13)
 *   DELETE /admin/shop/purchases/purge        X-Admin-Secret  → supprime en masse les commandes
 *        livrées/annulées (NOUVEAU v13, pour vider l'historique) — les commandes en attente sont conservées
 *
 * ── CALENDRIER DE STREAK — CONFIGURABLE (NOUVEAU v12) ──────────────────────
 *   GET /streak/config                         public          → { event_days, milestones, daily_reward_eclats }
 *        (utilisée par le site pour dessiner le calendrier — permet de raccourcir
 *        /allonger la durée et les paliers bonus pour un event sans toucher au code)
 *   GET /admin/streak-config                   X-Admin-Secret  → idem, pour préremplir le formulaire admin
 *   PUT /admin/streak-config                   X-Admin-Secret  → { event_days, milestones:[{day,bonus_eclats}], daily_reward_eclats }
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
 *     ('section:aide',         'true',  datetime('now')),
 *     ('section:recompense',   'true',  datetime('now'));
 *
 *   -- NOUVEAU v10 : si la table `site_flags` existe déjà (donc que l'INSERT
 *   -- OR IGNORE ci-dessus n'a pas d'effet sur les lignes déjà présentes),
 *   -- exécute juste ceci une fois pour ajouter le flag "recompense" :
 *   INSERT OR IGNORE INTO site_flags (key, value, updated_at)
 *     VALUES ('section:recompense', 'true', datetime('now'));
 *
 *   ALTER TABLE users ADD COLUMN minecraft_uuid     TEXT;
 *   ALTER TABLE users ADD COLUMN minecraft_username TEXT;
 *   CREATE UNIQUE INDEX IF NOT EXISTS idx_users_minecraft_uuid
 *     ON users(minecraft_uuid) WHERE minecraft_uuid IS NOT NULL;
 *
 *   ALTER TABLE player_stats ADD COLUMN deaths INTEGER DEFAULT 0;
 *
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
 *   -- Aucune nouvelle table nécessaire pour /forms : le rate limit
 *   -- réutilise la table kv_store déjà existante.
 *
 *   -- NOUVEAU v7 : mémorise quel discord_id a confirmé quel code /link,
 *   -- pour que le plugin MC puisse savoir (via /mc/link/status) que la
 *   -- liaison a été confirmée côté site, et agir en conséquence côté MC
 *   -- (ex: appeler l'API SDLink pour finaliser la vérification là-bas).
 *   ALTER TABLE link_codes ADD COLUMN confirmed_discord_id TEXT;
 *
 * ── NOUVEAU v8 : SYSTÈME D'ÉCLATS (économie de l'event) ───────────────────
 *   -- Colonnes ajoutées à `users`
 *   ALTER TABLE users ADD COLUMN eclats                   INTEGER NOT NULL DEFAULT 0;
 *   ALTER TABLE users ADD COLUMN is_partner               INTEGER NOT NULL DEFAULT 0;
 *   ALTER TABLE users ADD COLUMN partner_bonus_percent    INTEGER NOT NULL DEFAULT 0;
 *   ALTER TABLE users ADD COLUMN has_claimed_link_reward  INTEGER NOT NULL DEFAULT 0;
 *
 *   -- NOUVEAU v10 : code de parrainage personnel (généré à la demande, cf. /rewards/summary)
 *   ALTER TABLE users ADD COLUMN referral_code TEXT;
 *   CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code
 *     ON users(referral_code) WHERE referral_code IS NOT NULL;
 *
 *   -- Ledger (historique gains ET dépenses, utilisé par l'admin panel)
 *   CREATE TABLE IF NOT EXISTS eclats_transactions (
 *     id            INTEGER PRIMARY KEY AUTOINCREMENT,
 *     discord_id    TEXT NOT NULL,
 *     amount        INTEGER NOT NULL,   -- positif = gain, négatif = dépense
 *     reason        TEXT NOT NULL,      -- 'link_bonus' | 'streak_daily' | 'streak_milestone' |
 *                                        -- 'quest_easy'|'quest_medium'|'quest_hard'|'quest_custom' |
 *                                        -- 'referral_parrain'|'referral_filleul' | 'staff_bonus' |
 *                                        -- 'partner_bonus' | 'shop_purchase' | 'admin_grant' | 'admin_remove'
 *     balance_after INTEGER NOT NULL,
 *     meta          TEXT,               -- JSON libre (id de quête, id d'item acheté, etc.)
 *     created_at    TEXT NOT NULL
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_eclats_tx_discord ON eclats_transactions(discord_id);
 *
 *   -- Streaks (règles anti-abus : gel 1x/7j, validation 15min + blocs parcourus)
 *   CREATE TABLE IF NOT EXISTS streaks (
 *     discord_id             TEXT PRIMARY KEY,
 *     current_streak         INTEGER NOT NULL DEFAULT 0,
 *     longest_streak         INTEGER NOT NULL DEFAULT 0,
 *     last_valid_date        TEXT,   -- 'YYYY-MM-DD', dernier jour validé
 *     last_freeze_used_date  TEXT,   -- 'YYYY-MM-DD', dernier gel de streak utilisé
 *     playtime_seconds_today INTEGER NOT NULL DEFAULT 0,
 *     blocks_today           INTEGER NOT NULL DEFAULT 0,
 *     updated_at             TEXT
 *   );
 *
 *   -- NOUVEAU v12 : configuration du calendrier de streak (durée + paliers
 *   -- bonus), éditable depuis le panel admin — permet d'adapter facilement
 *   -- la durée du calendrier et les récompenses pour un event plus court/long.
 *   -- Ligne unique (id = 1). `milestones` est un JSON [{ "day": N, "bonus_eclats": N }, ...].
 *   CREATE TABLE IF NOT EXISTS streak_config (
 *     id                  INTEGER PRIMARY KEY CHECK (id = 1),
 *     event_days          INTEGER NOT NULL DEFAULT 26,
 *     milestones          TEXT    NOT NULL DEFAULT '[{"day":3,"bonus_eclats":20},{"day":7,"bonus_eclats":40},{"day":14,"bonus_eclats":80},{"day":21,"bonus_eclats":120},{"day":26,"bonus_eclats":200}]',
 *     daily_reward_eclats INTEGER NOT NULL DEFAULT 5,
 *     updated_at          TEXT
 *   );
 *   INSERT OR IGNORE INTO streak_config (id, event_days, daily_reward_eclats) VALUES (1, 26, 5);
 *
 *   -- Quêtes journalières
 *   CREATE TABLE IF NOT EXISTS quest_definitions (
 *     id            INTEGER PRIMARY KEY AUTOINCREMENT,
 *     quest_key     TEXT NOT NULL UNIQUE,
 *     title         TEXT NOT NULL,
 *     difficulty    TEXT NOT NULL,   -- 'easy' | 'medium' | 'hard' | 'custom'
 *     reward_eclats INTEGER NOT NULL,
 *     active        INTEGER NOT NULL DEFAULT 1,
 *     created_at    TEXT NOT NULL
 *   );
 *   CREATE TABLE IF NOT EXISTS quest_completions (
 *     discord_id      TEXT NOT NULL,
 *     quest_id        INTEGER NOT NULL,
 *     completion_date TEXT NOT NULL,  -- 'YYYY-MM-DD'
 *     created_at      TEXT NOT NULL,
 *     PRIMARY KEY (discord_id, quest_id, completion_date)
 *   );
 *
 *   -- Parrainage (anti-abus : un filleul n'a qu'un seul parrain, reward_given évite le double gain)
 *   CREATE TABLE IF NOT EXISTS referrals (
 *     filleul_discord_id TEXT PRIMARY KEY,
 *     parrain_discord_id TEXT NOT NULL,
 *     created_at         TEXT NOT NULL,
 *     validated           INTEGER NOT NULL DEFAULT 0,
 *     reward_given        INTEGER NOT NULL DEFAULT 0
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_referrals_parrain ON referrals(parrain_discord_id);
 *
 *   -- Boutique (paramétrable depuis l'adminpanel : visible/achetable, prix, quantités max, packs)
 *   CREATE TABLE IF NOT EXISTS shop_items (
 *     id               INTEGER PRIMARY KEY AUTOINCREMENT,
 *     item_key         TEXT NOT NULL UNIQUE,
 *     category         TEXT NOT NULL,  -- 'lootbox' | 'money_ig' | 'gift_card' | 'event_item' | 'vip'
 *     name             TEXT NOT NULL,
 *     description      TEXT,
 *     price_eclats     INTEGER NOT NULL,
 *     pack_quantity    INTEGER NOT NULL DEFAULT 1,  -- ex: x5, x10(+2 gratuites)=12
 *     max_per_player   INTEGER,        -- NULL = illimité
 *     max_total        INTEGER,        -- NULL = illimité
 *     purchased_total  INTEGER NOT NULL DEFAULT 0,
 *     visible          INTEGER NOT NULL DEFAULT 1,
 *     purchasable      INTEGER NOT NULL DEFAULT 1,
 *     promo_price      INTEGER,
 *     promo_active     INTEGER NOT NULL DEFAULT 0,
 *     sort_order       INTEGER NOT NULL DEFAULT 0,
 *     created_at       TEXT NOT NULL
 *   );
 *   CREATE TABLE IF NOT EXISTS shop_purchases (
 *     id            INTEGER PRIMARY KEY AUTOINCREMENT,
 *     discord_id    TEXT NOT NULL,
 *     item_id       INTEGER NOT NULL,
 *     quantity      INTEGER NOT NULL DEFAULT 1,
 *     eclats_spent  INTEGER NOT NULL,
 *     status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'fulfilled' | 'cancelled'
 *     created_at    TEXT NOT NULL,
 *     fulfilled_at  TEXT
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_shop_purchases_discord ON shop_purchases(discord_id);
 *   CREATE INDEX IF NOT EXISTS idx_shop_purchases_item    ON shop_purchases(item_id);
 *
 * ── NOUVEAU v11 ─────────────────────────────────────────────────────────────
 *   -- ⚠️ IMPORTANT : si `referral_code` n'a jamais été appliquée sur la vraie
 *   -- base D1 (seulement documentée ici), exécute impérativement ceci une
 *   -- fois via wrangler — sinon /rewards/summary, /link/confirm et le
 *   -- parrainage renvoient tous "D1_ERROR: no such column: referral_code" :
 *   --   ALTER TABLE users ADD COLUMN referral_code TEXT;
 *   --   CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code
 *   --     ON users(referral_code) WHERE referral_code IS NOT NULL;
 *
 *   -- Temps de jeu cumulé (secondes), alimenté par /stats. Sert de palier
 *   -- pour débloquer la récompense de parrainage (2h = 7200s minimum).
 *   ALTER TABLE users ADD COLUMN total_playtime_seconds INTEGER NOT NULL DEFAULT 0;
 *
 * ── VARIABLES / SECRETS WORKER À CONFIGURER (wrangler) ────────────────────
 *   LINK_SECRET     (secret — partagé avec le plugin Minecraft, protège /mc/link/request et /mc/link/status)
 *   wrangler secret put LINK_SECRET
 *
 *   AIDE_WEBHOOK    (secret — URL du webhook Discord du formulaire "aide")   ← NOUVEAU
 *   wrangler secret put AIDE_WEBHOOK
 *   (ajoute un secret WEBHOOK par formulaire déclaré dans FORM_TYPES)
 *
 *   Les secrets MS_CLIENT_ID / MS_CLIENT_SECRET ne sont plus utilisés en v5+,
 *   tu peux les retirer (wrangler secret delete MS_CLIENT_SECRET).
 *
 * ── NOUVEAU v7 : PONT SDLINK (lecture + statut de liaison) ─────────────────
 *   Le mod tiers "Simple Discord Link" (SDLink) stocke ses comptes vérifiés
 *   dans un fichier JSONL sur le serveur MC (cf. SDLINK_VERIFIED_PATH).
 *
 *   1) LECTURE : à la connexion Discord (/auth/discord), si l'utilisateur
 *      n'a pas encore de compte Minecraft lié chez nous, on regarde si
 *      SDLink le connaît déjà (même discordID) et on relie automatiquement
 *      → évite de refaire un /link si le joueur est déjà vérifié via SDLink.
 *
 *   2) STATUT : GET /mc/link/status?code=XXXXXX (X-Link-Secret) permet au
 *      plugin MC de savoir si un code /link a été confirmé côté site, et
 *      par quel discord_id — pour finaliser la vérification côté SDLink
 *      lui-même (via son API Java), sans jamais toucher son fichier JSON
 *      depuis le Worker.
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
const SITE_SECTIONS = ['home', 'modpack', 'lore', 'reglement', 'partenaires', 'ajouts', 'server', 'clans', 'team', 'about', 'staff', 'aide', 'recompense'];

// ── Système d'Éclats (v8) ───────────────────────────────────────────────
// Raisons valides pour une ligne de `eclats_transactions` (cf. doc migration v8 ci-dessus).
const ECLATS_REASONS = [
  'link_bonus', 'streak_daily', 'streak_milestone',
  'quest_easy', 'quest_medium', 'quest_hard', 'quest_custom',
  'referral_parrain', 'referral_filleul',
  'staff_bonus', 'partner_bonus',
  'shop_purchase', 'admin_grant', 'admin_remove',
];

// Catégories valides pour un `shop_items.category`
const SHOP_CATEGORIES = ['lootbox', 'money_ig', 'gift_card', 'event_item', 'vip'];

// Temps de jeu minimum (en secondes) que le FILLEUL doit cumuler avant que
// la récompense de parrainage (parrain + filleul) ne soit créditée. 2h = 7200s.
const REFERRAL_MIN_PLAYTIME_SECONDS = 2 * 60 * 60;

// Chemin du fichier verifiedaccounts.json de SDLink sur le serveur MC.
// À VÉRIFIER dans le gestionnaire de fichiers Pterodactyl si besoin.
const SDLINK_VERIFIED_PATH = '/sdlinkstorage/verifiedaccounts.json';

// ── FORMULAIRES → WEBHOOKS DISCORD ──────────────────────────────────────
// Ajoute une entrée par formulaire. `envKey` = nom du secret Worker qui
// contient l'URL du webhook Discord (jamais codée en dur ici).
const FORM_TYPES = {
  aide: { envKey: 'AIDE_WEBHOOK', cooldownMs: 24 * 60 * 60 * 1000 }, // 24h, aligné sur l'ancien AIDE_CD_MS côté front
  partner: { envKey: 'PARTNER_WEBHOOK', cooldownMs: 60 * 60 * 1000 },
  team:    { envKey: 'TEAM_WEBHOOK'},
};

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

// ── Comparaison de secrets en temps constant ────────────────────────────
// Évite les timing attacks sur les comparaisons de type `secret === env.X`.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
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

// ── Pont SDLink (lecture seule) ────────────────────────────────────────────
// Lit le fichier verifiedaccounts.json de SDLink via l'API Pterodactyl
// (même technique que collect_stats.py). Format JSONL : 1ère ligne =
// {"schemaVersion":"1.0"}, puis un objet JSON par compte.
async function getSdlinkVerifiedAccounts(env) {
  const r = await fetch(
    `${PANEL}/api/client/servers/${SERVER_ID}/files/contents?file=${encodeURIComponent(SDLINK_VERIFIED_PATH)}`,
    {
      headers: {
        'Authorization': `Bearer ${env.PTERO_API_KEY}`,
        'Accept': 'Application/vnd.pterodactyl.v1+json',
      },
    }
  );
  if (!r.ok) throw new Error(`Pterodactyl files/contents ${r.status}`);
  const text = await r.text();

  const accounts = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.uuid && obj.discordID) accounts.push(obj);
    } catch { /* ligne d'en-tête ou invalide, on ignore */ }
  }
  return accounts;
}

// Tente un lien automatique si l'utilisateur est déjà vérifié via SDLink.
// N'échoue jamais bruyamment : un souci de lecture Pterodactyl ne doit
// jamais casser la connexion Discord.
async function tryAutoLinkFromSdlink(discordId, env) {
  try {
    const verified = await getSdlinkVerifiedAccounts(env);
    const match = verified.find(a => String(a.discordID) === String(discordId));
    if (!match) return null;

    const conflict = await env.relinkdb.prepare(
      'SELECT discord_id FROM users WHERE minecraft_uuid = ? AND discord_id != ?'
    ).bind(match.uuid, discordId).first();
    if (conflict) return null; // déjà pris ailleurs côté ReLink, on ne force rien

    await env.relinkdb.prepare(
      'UPDATE users SET minecraft_uuid = ?, minecraft_username = ? WHERE discord_id = ?'
    ).bind(match.uuid, match.username, discordId).run();

    return { minecraft_uuid: match.uuid, minecraft_username: match.username };
  } catch (e) {
    console.error('[SDLink autolink] échec:', e.message);
    return null;
  }
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

  // NOUVEAU v7 : auto-link si déjà vérifié via SDLink et pas encore lié chez nous
  if (!user.minecraft_uuid) {
    const autoLink = await tryAutoLinkFromSdlink(dc.id, env);
    if (autoLink) Object.assign(user, autoLink);
  }

  const access_token = await signJWT(
    { discord_id: dc.id, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 },
    env.JWT_SECRET
  );
  return json({ ...user, access_token, is_new_user: !existing }, 200, origin);
}

// ── Liaison du compte Minecraft via code /link (crack-compatible) ─────────

function generateLinkCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Appelé par le plugin Minecraft (serveur -> Worker) quand un joueur tape /link.
 * Protégé par un secret partagé (X-Link-Secret), pas par une session Discord :
 * c'est le serveur MC qui parle au Worker, pas le joueur directement.
 *
 * CORRIGÉ v6 : plus aucun log ni retour du secret attendu/reçu. Le comportement
 * fonctionnel est strictement identique — seule la fuite d'info a été retirée.
 */
async function handleLinkRequest(request, env, origin) {
  const secret = request.headers.get('X-Link-Secret') || '';

  if (!env.LINK_SECRET || !secret || !timingSafeEqual(secret, env.LINK_SECRET)) {
    return json({ error: 'Non autorisé' }, 401, origin);
  }

  const { mc_uuid, mc_username, code: providedCode } = await request.json();
  if (!mc_uuid || !mc_username) return json({ error: 'Paramètres manquants' }, 400, origin);

  // NOUVEAU v7 : le plugin peut fournir son propre code (ex: le code de
  // vérification SDLink) plutôt que d'en laisser générer un nouveau ici —
  // un seul code, une seule saisie sur le site. On valide strictement le
  // format (6 chiffres) pour éviter d'injecter une valeur arbitraire.
  const code = (typeof providedCode === 'string' && /^\d{6}$/.test(providedCode))
    ? providedCode
    : generateLinkCode();
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
 * NOUVEAU v11 : accepte aussi un `referral_code` optionnel, saisi dans la même
 * modale, appliqué juste après la liaison réussie (au lieu d'une saisie a
 * posteriori sur la page Récompenses).
 */
async function handleLinkConfirm(request, env, origin) {
  const payload = await getUser(request, env);
  if (!payload) return json({ error: 'Non authentifié' }, 401, origin);

  const { code, referral_code } = await request.json();
  if (!code) return json({ error: 'Code manquant' }, 400, origin);

  const row = await env.relinkdb.prepare(
    'SELECT * FROM link_codes WHERE code = ? AND used = 0'
  ).bind(String(code).trim()).first();

  if (!row) return json({ error: 'Code invalide' }, 400, origin);
  if (Date.now() > row.expires_at) return json({ error: 'Code expiré, régénère-le avec /link en jeu' }, 400, origin);

  const conflict = await env.relinkdb.prepare(
    'SELECT discord_id FROM users WHERE minecraft_uuid = ? AND discord_id != ?'
  ).bind(row.mc_uuid, payload.discord_id).first();
  if (conflict) return json({ error: 'Ce compte Minecraft est déjà lié à un autre profil.' }, 409, origin);

  await env.relinkdb.batch([
    // NOUVEAU v7 : on mémorise qui a confirmé, pour /mc/link/status
    env.relinkdb.prepare('UPDATE link_codes SET used = 1, confirmed_discord_id = ? WHERE code = ?')
      .bind(payload.discord_id, row.code),
    env.relinkdb.prepare('UPDATE users SET minecraft_uuid = ?, minecraft_username = ? WHERE discord_id = ?')
      .bind(row.mc_uuid, row.mc_username, payload.discord_id),
  ]);

  let referral = null;
  const trimmedReferral = typeof referral_code === 'string' ? referral_code.trim() : '';
  if (trimmedReferral) {
    const result = await applyReferralCode(env, payload.discord_id, trimmedReferral);
    referral = result.ok
      ? { ok: true, parrain: result.parrain }
      : { ok: false, error: result.error };
  }

  return json({ ok: true, minecraft_uuid: row.mc_uuid, minecraft_username: row.mc_username, referral }, 200, origin);
}

/**
 * NOUVEAU v7 — Appelé par le plugin Minecraft (X-Link-Secret) pour savoir si
 * un code /link généré via /mc/link/request a été confirmé côté site, et par
 * quel discord_id. Permet au plugin de finaliser la vérification côté SDLink
 * (ou autre) directement en Java, sans que le Worker touche à leurs fichiers.
 */
async function handleLinkStatus(request, env, origin) {
  const secret = request.headers.get('X-Link-Secret') || '';
  if (!env.LINK_SECRET || !secret || !timingSafeEqual(secret, env.LINK_SECRET))
    return json({ error: 'Non autorisé' }, 401, origin);

  const code = new URL(request.url).searchParams.get('code');
  if (!code) return json({ error: 'code manquant' }, 400, origin);

  const row = await env.relinkdb.prepare(
    'SELECT used, confirmed_discord_id, expires_at FROM link_codes WHERE code = ?'
  ).bind(String(code).trim()).first();

  if (!row) return json({ found: false }, 200, origin);
  return json({
    found: true,
    used: !!row.used,
    discord_id: row.confirmed_discord_id || null,
    expired: Date.now() > row.expires_at,
  }, 200, origin);
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
    'SELECT discord_id, pseudo, email, avatar_url, status, minecraft_uuid, minecraft_username, eclats, is_partner, partner_bonus_percent FROM users WHERE discord_id = ?'
  ).bind(payload.discord_id).first();
  if (!user) return json({ error: 'Utilisateur introuvable' }, 404, origin);
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
  if (!env.STATS_SECRET || !timingSafeEqual(secret, env.STATS_SECRET))
    return json({ error: 'Non autorisé' }, 401, origin);

  const { players } = await request.json();
  if (!Array.isArray(players) || players.length === 0)
    return json({ error: 'Payload invalide' }, 400, origin);

  const stmt = env.relinkdb.prepare(
    `INSERT INTO player_stats (uuid, pseudo, kills, deaths, blocs_poses, fortune, dynasty, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(uuid) DO UPDATE SET
       pseudo      = excluded.pseudo,
       kills       = excluded.kills,
       deaths      = excluded.deaths,
       blocs_poses = excluded.blocs_poses,
       fortune     = excluded.fortune,
       dynasty     = excluded.dynasty,
       updated_at  = excluded.updated_at`
  );

  const batch = players.map(p =>
    stmt.bind(p.uuid, p.pseudo, p.kills || 0, p.deaths || 0, p.blocs_poses || 0, p.fortune || 0, p.dynasty || null)
  );
  await env.relinkdb.batch(batch);

  // NOUVEAU v11 : temps de jeu cumulé (optionnel — rempli par le futur
  // plugin/mod encore à connecter). Si un joueur fournit `playtime_seconds`
  // (total cumulé, pas un delta), on met à jour users.total_playtime_seconds
  // pour le compte lié à cet uuid, puis on vérifie si ça débloque une
  // récompense de parrainage en attente.
  const withPlaytime = players.filter(p => Number.isFinite(p.playtime_seconds));
  for (const p of withPlaytime) {
    const user = await env.relinkdb.prepare(
      'SELECT discord_id FROM users WHERE minecraft_uuid = ?'
    ).bind(p.uuid).first();
    if (!user) continue;

    await env.relinkdb.prepare(
      'UPDATE users SET total_playtime_seconds = ? WHERE discord_id = ?'
    ).bind(Math.max(0, Math.floor(p.playtime_seconds)), user.discord_id).run();

    await checkAndGrantPendingReferralReward(env, user.discord_id);
  }

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
    `SELECT ps.uuid, ps.pseudo, ps.kills, ps.deaths, ps.blocs_poses, ps.fortune, ps.dynasty, ps.updated_at,
            COALESCE(u_uuid.avatar_url, u_pseudo.avatar_url)   AS avatar_url,
            COALESCE(u_uuid.discord_id, u_pseudo.discord_id)   AS discord_id,
            (u_uuid.discord_id IS NOT NULL)                    AS linked
     FROM player_stats ps
     LEFT JOIN users u_uuid   ON u_uuid.minecraft_uuid = ps.uuid
     LEFT JOIN users u_pseudo ON LOWER(u_pseudo.pseudo) = LOWER(ps.pseudo)
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
  if (!env.STATS_SECRET || !timingSafeEqual(secret, env.STATS_SECRET))
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
  if (!env.ADMIN_SECRET || !timingSafeEqual(secret, env.ADMIN_SECRET))
    return json({ error: 'Non autorisé' }, 401, origin);

  const discordId = new URL(request.url).searchParams.get('discord_id');
  if (!discordId) return json({ error: 'discord_id manquant' }, 400, origin);

  await env.relinkdb.prepare(
    'DELETE FROM submissions WHERE discord_id = ? AND type = ?'
  ).bind(discordId, type).run();

  return json({ ok: true, unlocked: discordId, type }, 200, origin);
}

// ════════════════════════════════════════════════════════════════════════════
// HANDLER FORMULAIRES → DISCORD (NOUVEAU v6)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Relaie un formulaire du site vers le webhook Discord correspondant, sans
 * jamais exposer l'URL du webhook côté client.
 *
 * Sécurités :
 *  - Webhook stocké en secret Worker (env[config.envKey]), invisible du front.
 *  - Rate limit serveur par IP + par type de formulaire (table kv_store déjà
 *    existante), donc impossible à contourner en vidant le localStorage.
 *  - Honeypot : un champ caché "_hp" rempli = requête silencieusement ignorée
 *    (on répond 200 "ok" pour ne pas donner d'info au bot).
 *  - Le message Discord est reconstruit côté serveur (titre + fields), donc
 *    un tiers qui spamme l'endpoint ne peut pas injecter un embed arbitraire.
 */
async function handleFormSubmit(request, env, origin, type) {
  const config = FORM_TYPES[type];
  if (!config) return json({ error: 'Formulaire inconnu' }, 404, origin);

  const webhookUrl = env[config.envKey];
  if (!webhookUrl) return json({ error: 'Webhook non configuré' }, 500, origin);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Payload invalide' }, 400, origin); }
  if (!body || typeof body !== 'object') return json({ error: 'Payload invalide' }, 400, origin);

  // Honeypot anti-bot
  if (body._hp) return json({ ok: true }, 200, origin);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = `formrate:${type}:${ip}`;
  const last = await env.relinkdb.prepare(
    'SELECT value FROM kv_store WHERE key = ?'
  ).bind(rlKey).first();

  const now = Date.now();
  if (last && now - parseInt(last.value, 10) < config.cooldownMs) {
    const waitMs = config.cooldownMs - (now - parseInt(last.value, 10));
    return json({ error: 'Trop de requêtes, réessaie plus tard', retry_after_ms: waitMs }, 429, origin);
  }

  const discordPayload = {
    content: null,
    embeds: [{
      title: `Nouveau formulaire : ${type}`,
      fields: Object.entries(body)
        .filter(([k]) => k !== '_hp')
        .slice(0, 25) // Discord limite à 25 fields par embed
        .map(([k, v]) => ({
          name: String(k).slice(0, 256) || '—',
          value: String(v).slice(0, 1000) || '—',
        })),
      timestamp: new Date().toISOString(),
    }],
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(discordPayload),
  });

  if (!res.ok) return json({ error: 'Échec envoi Discord' }, 502, origin);

  await env.relinkdb.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(rlKey, String(now)).run();

  return json({ ok: true }, 200, origin);
}

// ════════════════════════════════════════════════════════════════════════════
// HANDLERS ADMIN + FLAGS
// ════════════════════════════════════════════════════════════════════════════

function checkAdmin(request, env) {
  const secret = request.headers.get('X-Admin-Secret') || '';
  return !!env.ADMIN_SECRET && timingSafeEqual(secret, env.ADMIN_SECRET);
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
      u.eclats, u.is_partner, u.partner_bonus_percent,
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

// ── POST /admin/users/:discord_id/force-link ──────────────────────────────
// Lie manuellement un compte ReLink à un pseudo/UUID Minecraft, sans passer
// par le code /link en jeu. Réservé à l'admin. "Force" car si l'UUID fourni
// est déjà lié à un AUTRE compte Discord, cette ancienne liaison est retirée
// avant d'appliquer la nouvelle (contrairement à /link/confirm qui refuse
// en cas de conflit).
async function handleAdminForceLink(request, env, origin, discordId) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);

  const { mc_uuid, mc_username } = await request.json();
  if (!mc_uuid || !mc_username) return json({ error: 'mc_uuid et mc_username requis' }, 400, origin);

  const user = await env.relinkdb.prepare('SELECT discord_id FROM users WHERE discord_id = ?').bind(discordId).first();
  if (!user) return json({ error: 'Utilisateur introuvable' }, 404, origin);

  await env.relinkdb.batch([
    // Retire cet UUID de tout autre compte qui l'aurait déjà (le "force")
    env.relinkdb.prepare(
      'UPDATE users SET minecraft_uuid = NULL, minecraft_username = NULL WHERE minecraft_uuid = ? AND discord_id != ?'
    ).bind(mc_uuid, discordId),
    // Applique la liaison sur le compte ciblé
    env.relinkdb.prepare(
      'UPDATE users SET minecraft_uuid = ?, minecraft_username = ? WHERE discord_id = ?'
    ).bind(mc_uuid, mc_username, discordId),
    // Nettoie un éventuel code /link en attente pour cet UUID
    env.relinkdb.prepare('DELETE FROM link_codes WHERE mc_uuid = ?').bind(mc_uuid),
  ]);

  return json({ ok: true, discord_id: discordId, minecraft_uuid: mc_uuid, minecraft_username: mc_username }, 200, origin);
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

// ════════════════════════════════════════════════════════════════════════════
// HANDLERS ADMIN — ÉCLATS & BOUTIQUE (NOUVEAU v9)
// ════════════════════════════════════════════════════════════════════════════

// Crédite/débite un joueur et journalise dans eclats_transactions.
// `amount` peut être négatif (retrait) ; le solde ne descend jamais sous 0.
async function grantEclatsInternal(env, discordId, amount, reason, meta = null) {
  const user = await env.relinkdb.prepare('SELECT eclats FROM users WHERE discord_id = ?').bind(discordId).first();
  if (!user) return null;
  const newBalance = Math.max(0, (user.eclats || 0) + amount);
  await env.relinkdb.batch([
    env.relinkdb.prepare('UPDATE users SET eclats = ? WHERE discord_id = ?').bind(newBalance, discordId),
    env.relinkdb.prepare(
      `INSERT INTO eclats_transactions (discord_id, amount, reason, balance_after, meta, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(discordId, amount, reason, newBalance, meta ? JSON.stringify(meta) : null),
  ]);
  return newBalance;
}

// POST /admin/eclats/grant — { discord_id, amount, reason? }
// amount > 0 = don ; amount < 0 = retrait. reason par défaut : admin_grant / admin_remove.
async function handleAdminGrantEclats(request, env, origin) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);
  const { discord_id, amount, reason } = await request.json();
  const amt = parseInt(amount, 10);
  if (!discord_id || !Number.isFinite(amt) || amt === 0)
    return json({ error: 'discord_id et amount (entier non nul) requis' }, 400, origin);

  const finalReason = ECLATS_REASONS.includes(reason) ? reason : (amt > 0 ? 'admin_grant' : 'admin_remove');
  const newBalance = await grantEclatsInternal(env, discord_id, amt, finalReason);
  if (newBalance === null) return json({ error: 'Utilisateur introuvable' }, 404, origin);

  return json({ ok: true, discord_id, amount: amt, reason: finalReason, balance: newBalance }, 200, origin);
}

// POST /admin/eclats/partner — { discord_id, is_partner, partner_bonus_percent, apply_bonus? }
// `apply_bonus` (optionnel) crédite immédiatement un montant d'éclats (ex: bonus d'entrée en partenariat).
async function handleAdminSetPartner(request, env, origin) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);
  const { discord_id, is_partner, partner_bonus_percent, apply_bonus } = await request.json();
  if (!discord_id) return json({ error: 'discord_id requis' }, 400, origin);

  const user = await env.relinkdb.prepare('SELECT discord_id, eclats FROM users WHERE discord_id = ?').bind(discord_id).first();
  if (!user) return json({ error: 'Utilisateur introuvable' }, 404, origin);

  const pct = Math.max(0, Math.min(100, parseInt(partner_bonus_percent, 10) || 0));
  await env.relinkdb.prepare(
    'UPDATE users SET is_partner = ?, partner_bonus_percent = ? WHERE discord_id = ?'
  ).bind(is_partner ? 1 : 0, pct, discord_id).run();

  let newBalance = user.eclats;
  const bonusAmount = parseInt(apply_bonus, 10);
  if (is_partner && Number.isFinite(bonusAmount) && bonusAmount !== 0) {
    newBalance = await grantEclatsInternal(env, discord_id, bonusAmount, 'partner_bonus');
  }

  return json({ ok: true, discord_id, is_partner: !!is_partner, partner_bonus_percent: pct, balance: newBalance }, 200, origin);
}

// GET /admin/shop — tous les articles (visibles ou non), pour la gestion
async function handleAdminGetShop(request, env, origin) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);
  const rows = await env.relinkdb.prepare('SELECT * FROM shop_items ORDER BY sort_order ASC, id ASC').all();
  return json({ items: rows.results || [] }, 200, origin);
}

// GET /shop — public, articles visibles uniquement (pour le site)
async function handleGetShop(env, origin) {
  const rows = await env.relinkdb.prepare(
    `SELECT id, item_key, category, name, description, price_eclats, pack_quantity,
            max_per_player, max_total, purchased_total, promo_price, promo_active, sort_order
     FROM shop_items WHERE visible = 1 ORDER BY sort_order ASC, id ASC`
  ).all();
  return json({ items: rows.results || [] }, 200, origin);
}

// POST /admin/shop — créer un article de boutique
async function handleAdminCreateShopItem(request, env, origin) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);
  const b = await request.json();
  if (!b.item_key || !b.category || !b.name || !Number.isFinite(parseInt(b.price_eclats, 10)))
    return json({ error: 'item_key, category, name et price_eclats sont requis' }, 400, origin);
  if (!SHOP_CATEGORIES.includes(b.category))
    return json({ error: 'category invalide', allowed: SHOP_CATEGORIES }, 400, origin);

  try {
    await env.relinkdb.prepare(
      `INSERT INTO shop_items
        (item_key, category, name, description, price_eclats, pack_quantity, max_per_player, max_total,
         visible, purchasable, promo_price, promo_active, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(
      b.item_key, b.category, b.name, b.description || null,
      parseInt(b.price_eclats, 10), parseInt(b.pack_quantity, 10) || 1,
      (b.max_per_player === '' || b.max_per_player == null) ? null : parseInt(b.max_per_player, 10),
      (b.max_total === '' || b.max_total == null) ? null : parseInt(b.max_total, 10),
      b.visible === false ? 0 : 1, b.purchasable === false ? 0 : 1,
      (b.promo_price === '' || b.promo_price == null) ? null : parseInt(b.promo_price, 10),
      b.promo_active ? 1 : 0, parseInt(b.sort_order, 10) || 0,
    ).run();
  } catch (e) {
    return json({ error: 'item_key déjà utilisé ou erreur : ' + e.message }, 409, origin);
  }
  return json({ ok: true }, 200, origin);
}

// PUT /admin/shop/:id — modifie un article (prix, visible, achetable, quantités max, pack, promo…)
async function handleAdminUpdateShopItem(request, env, origin, id) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);
  const b = await request.json();

  const intFields  = ['price_eclats', 'pack_quantity', 'max_per_player', 'max_total', 'promo_price', 'sort_order'];
  const boolFields = ['visible', 'purchasable', 'promo_active'];
  const strFields  = ['name', 'description', 'category'];

  const sets = [];
  const values = [];
  for (const f of strFields)  if (f in b) { sets.push(`${f} = ?`); values.push(b[f]); }
  for (const f of boolFields) if (f in b) { sets.push(`${f} = ?`); values.push(b[f] ? 1 : 0); }
  for (const f of intFields)  if (f in b) {
    sets.push(`${f} = ?`);
    values.push((b[f] === '' || b[f] == null) ? null : parseInt(b[f], 10));
  }
  if (!sets.length) return json({ error: 'Aucun champ à mettre à jour' }, 400, origin);

  values.push(id);
  await env.relinkdb.prepare(`UPDATE shop_items SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  return json({ ok: true }, 200, origin);
}

// DELETE /admin/shop/:id — supprime un article
async function handleAdminDeleteShopItem(request, env, origin, id) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);
  await env.relinkdb.prepare('DELETE FROM shop_items WHERE id = ?').bind(id).run();
  return json({ ok: true }, 200, origin);
}

// POST /admin/shop/:id/grant — { discord_id, quantity } — offre gratuitement un article à un membre
// (aucun débit d'éclats, marqué "fulfilled" directement, pour distribuer une récompense manuelle)
async function handleAdminGrantShopItem(request, env, origin, id) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);
  const { discord_id, quantity } = await request.json();
  const qty = parseInt(quantity, 10) || 1;
  if (!discord_id) return json({ error: 'discord_id requis' }, 400, origin);

  const item = await env.relinkdb.prepare('SELECT * FROM shop_items WHERE id = ?').bind(id).first();
  if (!item) return json({ error: 'Article introuvable' }, 404, origin);

  const user = await env.relinkdb.prepare('SELECT discord_id FROM users WHERE discord_id = ?').bind(discord_id).first();
  if (!user) return json({ error: 'Utilisateur introuvable' }, 404, origin);

  await env.relinkdb.batch([
    env.relinkdb.prepare(
      `INSERT INTO shop_purchases (discord_id, item_id, quantity, eclats_spent, status, created_at, fulfilled_at)
       VALUES (?, ?, ?, 0, 'fulfilled', datetime('now'), datetime('now'))`
    ).bind(discord_id, id, qty),
    env.relinkdb.prepare('UPDATE shop_items SET purchased_total = purchased_total + ? WHERE id = ?').bind(qty, id),
  ]);

  return json({ ok: true, discord_id, item: item.name, quantity: qty }, 200, origin);
}

// GET /admin/shop/purchases — NOUVEAU v11 — suivi des commandes de la boutique
// ?status=pending|fulfilled|cancelled (optionnel) &limit=&offset=
async function handleAdminGetShopPurchases(request, env, origin) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);

  const url    = new URL(request.url);
  const status = url.searchParams.get('status') || '';
  const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const base = `
    SELECT sp.id, sp.discord_id, sp.item_id, sp.quantity, sp.eclats_spent, sp.status,
           sp.created_at, sp.fulfilled_at,
           si.name AS item_name, si.category,
           u.pseudo, u.avatar_url, u.minecraft_username
    FROM shop_purchases sp
    JOIN shop_items si ON si.id = sp.item_id
    LEFT JOIN users u  ON u.discord_id = sp.discord_id`;

  let rows, total;
  if (['pending', 'fulfilled', 'cancelled'].includes(status)) {
    rows  = await env.relinkdb.prepare(base + ' WHERE sp.status = ? ORDER BY sp.created_at DESC LIMIT ? OFFSET ?')
      .bind(status, limit, offset).all();
    total = await env.relinkdb.prepare('SELECT COUNT(*) AS n FROM shop_purchases WHERE status = ?').bind(status).first();
  } else {
    rows  = await env.relinkdb.prepare(base + ' ORDER BY sp.created_at DESC LIMIT ? OFFSET ?').bind(limit, offset).all();
    total = await env.relinkdb.prepare('SELECT COUNT(*) AS n FROM shop_purchases').first();
  }

  return json({ purchases: rows.results || [], total: total?.n || 0 }, 200, origin);
}

// POST /admin/shop/purchases/:id/status — NOUVEAU v11 — { status: pending|fulfilled|cancelled }
async function handleAdminUpdatePurchaseStatus(request, env, origin, id) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);
  const { status } = await request.json();
  if (!['pending', 'fulfilled', 'cancelled'].includes(status))
    return json({ error: 'status invalide' }, 400, origin);

  const purchase = await env.relinkdb.prepare('SELECT * FROM shop_purchases WHERE id = ?').bind(id).first();
  if (!purchase) return json({ error: 'Commande introuvable' }, 404, origin);

  await env.relinkdb.prepare(
    `UPDATE shop_purchases SET status = ?, fulfilled_at = ? WHERE id = ?`
  ).bind(status, status === 'fulfilled' ? new Date().toISOString() : purchase.fulfilled_at, id).run();

  // Si on annule une commande, on rembourse les éclats dépensés au joueur.
  if (status === 'cancelled' && purchase.status !== 'cancelled' && purchase.eclats_spent > 0) {
    await grantEclatsInternal(env, purchase.discord_id, purchase.eclats_spent, 'admin_grant', { refund_purchase_id: Number(id) });
  }

  return json({ ok: true, id: Number(id), status }, 200, origin);
}

// DELETE /admin/shop/purchases/:id — NOUVEAU v13 — supprime une commande précise
// de l'historique (aucun remboursement : à utiliser pour du nettoyage, pas pour
// annuler un achat en cours — pour ça, POST .../status avec 'cancelled').
async function handleAdminDeletePurchase(request, env, origin, id) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);
  const purchase = await env.relinkdb.prepare('SELECT id FROM shop_purchases WHERE id = ?').bind(id).first();
  if (!purchase) return json({ error: 'Commande introuvable' }, 404, origin);

  await env.relinkdb.prepare('DELETE FROM shop_purchases WHERE id = ?').bind(id).run();
  return json({ ok: true, deleted: 1 }, 200, origin);
}

// DELETE /admin/shop/purchases/purge — NOUVEAU v13 — supprime en masse les
// commandes "passées" (livrées ou annulées), pour vider l'historique sans
// toucher aux commandes encore en attente. Ne rembourse jamais d'éclats.
async function handleAdminPurgePastPurchases(request, env, origin) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);
  const result = await env.relinkdb.prepare(
    `DELETE FROM shop_purchases WHERE status IN ('fulfilled', 'cancelled')`
  ).run();
  return json({ ok: true, deleted: result.meta?.changes || 0 }, 200, origin);
}

// ════════════════════════════════════════════════════════════════════════════
// CALENDRIER DE STREAK — CONFIGURATION (NOUVEAU v12)
// ════════════════════════════════════════════════════════════════════════════

const STREAK_CONFIG_LIMITS = { minDays: 1, maxDays: 90, maxMilestoneBonus: 5000, maxDailyReward: 500 };

// Lit la config (ligne singleton id=1), et la crée avec les valeurs par défaut
// si elle n'existe pas encore (ex: si l'INSERT OR IGNORE de la migration n'a
// pas encore été exécuté).
async function getStreakConfig(env) {
  let row = await env.relinkdb.prepare('SELECT * FROM streak_config WHERE id = 1').first();
  if (!row) {
    const defaultMilestones = JSON.stringify([
      { day: 3, bonus_eclats: 20 }, { day: 7, bonus_eclats: 40 }, { day: 14, bonus_eclats: 80 },
      { day: 21, bonus_eclats: 120 }, { day: 26, bonus_eclats: 200 },
    ]);
    await env.relinkdb.prepare(
      `INSERT OR IGNORE INTO streak_config (id, event_days, milestones, daily_reward_eclats, updated_at)
       VALUES (1, 26, ?, 5, datetime('now'))`
    ).bind(defaultMilestones).run();
    row = await env.relinkdb.prepare('SELECT * FROM streak_config WHERE id = 1').first();
  }
  let milestones = [];
  try { milestones = JSON.parse(row.milestones || '[]'); } catch (e) { milestones = []; }
  return {
    event_days: row.event_days,
    milestones,
    daily_reward_eclats: row.daily_reward_eclats,
  };
}

// GET /streak/config — public — utilisée par le site pour dessiner le calendrier
async function handleGetStreakConfig(request, env, origin) {
  const config = await getStreakConfig(env);
  return json(config, 200, origin);
}

// GET /admin/streak-config — X-Admin-Secret — préremplit le formulaire admin
async function handleAdminGetStreakConfig(request, env, origin) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);
  const config = await getStreakConfig(env);
  return json(config, 200, origin);
}

// PUT /admin/streak-config — X-Admin-Secret — { event_days, milestones, daily_reward_eclats }
// Permet d'adapter la durée du calendrier et les paliers bonus pour un event
// plus court ou plus long, sans toucher au code.
async function handleAdminUpdateStreakConfig(request, env, origin) {
  if (!checkAdmin(request, env)) return json({ error: 'Non autorisé' }, 401, origin);
  const b = await request.json();

  const eventDays = parseInt(b.event_days, 10);
  if (!Number.isInteger(eventDays) || eventDays < STREAK_CONFIG_LIMITS.minDays || eventDays > STREAK_CONFIG_LIMITS.maxDays)
    return json({ error: `event_days doit être un entier entre ${STREAK_CONFIG_LIMITS.minDays} et ${STREAK_CONFIG_LIMITS.maxDays}` }, 400, origin);

  const dailyReward = parseInt(b.daily_reward_eclats, 10);
  if (!Number.isInteger(dailyReward) || dailyReward < 0 || dailyReward > STREAK_CONFIG_LIMITS.maxDailyReward)
    return json({ error: `daily_reward_eclats doit être un entier entre 0 et ${STREAK_CONFIG_LIMITS.maxDailyReward}` }, 400, origin);

  if (!Array.isArray(b.milestones))
    return json({ error: 'milestones doit être une liste' }, 400, origin);

  const seenDays = new Set();
  const milestones = [];
  for (const m of b.milestones) {
    const day = parseInt(m.day, 10);
    const bonus = parseInt(m.bonus_eclats, 10);
    if (!Number.isInteger(day) || day < 1 || day > eventDays)
      return json({ error: `Un palier a un jour invalide (doit être entre 1 et ${eventDays})` }, 400, origin);
    if (!Number.isInteger(bonus) || bonus < 0 || bonus > STREAK_CONFIG_LIMITS.maxMilestoneBonus)
      return json({ error: `Un palier a un bonus invalide (doit être entre 0 et ${STREAK_CONFIG_LIMITS.maxMilestoneBonus})` }, 400, origin);
    if (seenDays.has(day))
      return json({ error: `Le jour ${day} est utilisé par plusieurs paliers` }, 400, origin);
    seenDays.add(day);
    milestones.push({ day, bonus_eclats: bonus });
  }
  milestones.sort((a, b2) => a.day - b2.day);

  await env.relinkdb.prepare(
    `INSERT INTO streak_config (id, event_days, milestones, daily_reward_eclats, updated_at)
     VALUES (1, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       event_days = excluded.event_days,
       milestones = excluded.milestones,
       daily_reward_eclats = excluded.daily_reward_eclats,
       updated_at = excluded.updated_at`
  ).bind(eventDays, JSON.stringify(milestones), dailyReward).run();

  return json({ ok: true, event_days: eventDays, milestones, daily_reward_eclats: dailyReward }, 200, origin);
}

// ════════════════════════════════════════════════════════════════════════════
// HANDLERS SITE — ÉCLATS, PARRAINAGE, STREAK, ACHATS (NOUVEAU v10)
// ════════════════════════════════════════════════════════════════════════════

// Génère un code de parrainage lisible (évite les caractères ambigus 0/O, 1/I/L).
function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Renvoie le code de parrainage du joueur, en le générant au premier appel.
async function ensureReferralCode(env, discordId, existingCode) {
  if (existingCode) return existingCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    try {
      await env.relinkdb.prepare('UPDATE users SET referral_code = ? WHERE discord_id = ?').bind(code, discordId).run();
      return code;
    } catch (e) { /* collision très improbable, on retente */ }
  }
  throw new Error('Impossible de générer un code de parrainage unique');
}

// GET /rewards/summary — Bearer — vue d'ensemble pour la page Récompenses du site
async function handleRewardsSummary(request, env, origin) {
  const payload = await getUser(request, env);
  if (!payload) return json({ error: 'Non authentifié' }, 401, origin);

  const user = await env.relinkdb.prepare(
    'SELECT eclats, is_partner, partner_bonus_percent, referral_code, total_playtime_seconds FROM users WHERE discord_id = ?'
  ).bind(payload.discord_id).first();
  if (!user) return json({ error: 'Utilisateur introuvable' }, 404, origin);

  const referral_code = await ensureReferralCode(env, payload.discord_id, user.referral_code);

  const referralCount = await env.relinkdb.prepare(
    'SELECT COUNT(*) AS n FROM referrals WHERE parrain_discord_id = ? AND reward_given = 1'
  ).bind(payload.discord_id).first();

  // NOUVEAU v11 : statut du parrainage dont CE compte est le filleul (le cas
  // échéant), pour afficher "en attente de 2h de jeu" côté site.
  const asFilleul = await env.relinkdb.prepare(
    `SELECT r.reward_given, u.pseudo AS parrain_pseudo
     FROM referrals r JOIN users u ON u.discord_id = r.parrain_discord_id
     WHERE r.filleul_discord_id = ?`
  ).bind(payload.discord_id).first();

  const referral_status = asFilleul
    ? {
        used_code: true,
        parrain: asFilleul.parrain_pseudo,
        reward_given: !!asFilleul.reward_given,
        playtime_seconds: user.total_playtime_seconds || 0,
        playtime_required_seconds: REFERRAL_MIN_PLAYTIME_SECONDS,
      }
    : { used_code: false };

  const streak = await env.relinkdb.prepare(
    `SELECT current_streak, longest_streak, last_valid_date, last_freeze_used_date,
            playtime_seconds_today, blocks_today
     FROM streaks WHERE discord_id = ?`
  ).bind(payload.discord_id).first();

  return json({
    eclats: user.eclats || 0,
    is_partner: !!user.is_partner,
    partner_bonus_percent: user.partner_bonus_percent || 0,
    referral_code,
    referral_count: referralCount?.n || 0,
    referral_status,
    streak: streak || {
      current_streak: 0, longest_streak: 0, last_valid_date: null,
      last_freeze_used_date: null, playtime_seconds_today: 0, blocks_today: 0,
    },
  }, 200, origin);
}

// NOUVEAU v11 — Enregistre l'usage d'un code de parrainage par `filleulDiscordId`.
// Ne crédite PLUS les Éclats immédiatement : le parrainage est créé en attente
// (validated=0, reward_given=0) et la récompense est versée plus tard par
// checkAndGrantPendingReferralReward() une fois le palier de temps de jeu atteint.
// Règles anti-abus inchangées : un filleul n'a qu'un seul parrain (PK sur
// referrals), impossible de se parrainer soi-même.
// Retourne { ok: true, parrain } ou { ok: false, error, status }.
async function applyReferralCode(env, filleulDiscordId, code) {
  if (!code) return { ok: false, error: 'Code manquant', status: 400 };

  const parrain = await env.relinkdb.prepare(
    'SELECT discord_id, pseudo FROM users WHERE referral_code = ?'
  ).bind(String(code).trim().toUpperCase()).first();
  if (!parrain) return { ok: false, error: 'Code de parrainage invalide', status: 404 };
  if (parrain.discord_id === filleulDiscordId)
    return { ok: false, error: 'Impossible de te parrainer toi-même', status: 400 };

  const existing = await env.relinkdb.prepare(
    'SELECT parrain_discord_id FROM referrals WHERE filleul_discord_id = ?'
  ).bind(filleulDiscordId).first();
  if (existing) return { ok: false, error: 'Tu as déjà utilisé un code de parrainage', status: 409 };

  try {
    await env.relinkdb.prepare(
      `INSERT INTO referrals (filleul_discord_id, parrain_discord_id, created_at, validated, reward_given)
       VALUES (?, ?, datetime('now'), 0, 0)`
    ).bind(filleulDiscordId, parrain.discord_id).run();
  } catch (e) {
    return { ok: false, error: 'Ce parrainage a déjà été enregistré', status: 409 };
  }

  // Si le filleul a déjà (par exemple via une liaison précédente) le temps de
  // jeu requis, on peut créditer immédiatement — sinon ça restera en attente.
  await checkAndGrantPendingReferralReward(env, filleulDiscordId);

  return { ok: true, parrain: parrain.pseudo };
}

// NOUVEAU v11 — Vérifie si `discordId` a un parrainage en attente (en tant que
// filleul) et si son temps de jeu cumulé atteint REFERRAL_MIN_PLAYTIME_SECONDS ;
// si oui, crédite les Éclats au parrain (150) et au filleul (100) une seule fois.
async function checkAndGrantPendingReferralReward(env, discordId) {
  const pending = await env.relinkdb.prepare(
    'SELECT parrain_discord_id FROM referrals WHERE filleul_discord_id = ? AND reward_given = 0'
  ).bind(discordId).first();
  if (!pending) return;

  const user = await env.relinkdb.prepare(
    'SELECT total_playtime_seconds FROM users WHERE discord_id = ?'
  ).bind(discordId).first();
  if (!user || (user.total_playtime_seconds || 0) < REFERRAL_MIN_PLAYTIME_SECONDS) return;

  await env.relinkdb.prepare(
    'UPDATE referrals SET validated = 1, reward_given = 1 WHERE filleul_discord_id = ?'
  ).bind(discordId).run();

  await grantEclatsInternal(env, pending.parrain_discord_id, 150, 'referral_parrain', { filleul: discordId });
  await grantEclatsInternal(env, discordId, 100, 'referral_filleul', { parrain: pending.parrain_discord_id });
}

// POST /referral/redeem — Bearer — { code } — applique le code d'un parrain
// NOUVEAU v11 : conservé pour rattrapage (ex: joueur déjà lié avant cette
// mise à jour), mais la saisie se fait désormais normalement dans la modale
// /link. Ne crédite plus rien tant que le palier de 2h n'est pas atteint.
async function handleReferralRedeem(request, env, origin) {
  const payload = await getUser(request, env);
  if (!payload) return json({ error: 'Non authentifié' }, 401, origin);

  const { code } = await request.json();
  const result = await applyReferralCode(env, payload.discord_id, code);
  if (!result.ok) return json({ error: result.error }, result.status, origin);

  return json({
    ok: true,
    parrain: result.parrain,
    pending: true,
    message: `Code accepté ! Toi et ${result.parrain} recevrez vos Éclats dès que tu auras cumulé 2h de jeu.`,
  }, 200, origin);
}

// GET /leaderboard/referrals?limit=10 — public — top parrains par nombre de filleuls validés
async function handleReferralLeaderboard(request, env, origin) {
  const limit = Math.min(parseInt(new URL(request.url).searchParams.get('limit') || '10', 10), 50);
  const rows = await env.relinkdb.prepare(
    `SELECT u.discord_id, u.pseudo, u.avatar_url, COUNT(r.filleul_discord_id) AS referral_count
     FROM referrals r JOIN users u ON u.discord_id = r.parrain_discord_id
     WHERE r.reward_given = 1
     GROUP BY r.parrain_discord_id
     ORDER BY referral_count DESC
     LIMIT ?`
  ).bind(limit).all();
  return json({ results: (rows.results || []).map((r, i) => ({ rank: i + 1, ...r })) }, 200, origin);
}

// GET /leaderboard/streak?limit=10 — public — top streaks en cours
async function handleStreakLeaderboard(request, env, origin) {
  const limit = Math.min(parseInt(new URL(request.url).searchParams.get('limit') || '10', 10), 50);
  const rows = await env.relinkdb.prepare(
    `SELECT u.discord_id, u.pseudo, u.avatar_url, s.current_streak, s.longest_streak
     FROM streaks s JOIN users u ON u.discord_id = s.discord_id
     WHERE s.current_streak > 0
     ORDER BY s.current_streak DESC, s.longest_streak DESC
     LIMIT ?`
  ).bind(limit).all();
  return json({ results: (rows.results || []).map((r, i) => ({ rank: i + 1, ...r })) }, 200, origin);
}

// GET /shop/purchases/me — Bearer — historique d'achats du joueur connecté
async function handleShopPurchasesMe(request, env, origin) {
  const payload = await getUser(request, env);
  if (!payload) return json({ error: 'Non authentifié' }, 401, origin);
  const rows = await env.relinkdb.prepare(
    `SELECT sp.id, sp.item_id, sp.quantity, sp.eclats_spent, sp.status, sp.created_at, si.name, si.category
     FROM shop_purchases sp JOIN shop_items si ON si.id = sp.item_id
     WHERE sp.discord_id = ? ORDER BY sp.created_at DESC LIMIT 50`
  ).bind(payload.discord_id).all();
  return json({ purchases: rows.results || [] }, 200, origin);
}

// POST /shop/:id/purchase — Bearer — { quantity? } — achat réel : débite les éclats du joueur
// et respecte purchasable/visible, max_per_player et max_total. Les achats restent en
// statut 'pending' pour que le staff les livre en jeu (cf. table shop_purchases).
async function handleShopPurchase(request, env, origin, id) {
  const payload = await getUser(request, env);
  if (!payload) return json({ error: 'Non authentifié' }, 401, origin);

  let body = {};
  try { body = await request.json(); } catch { /* corps optionnel */ }
  const qty = parseInt(body.quantity, 10) || 1;
  if (qty < 1) return json({ error: 'Quantité invalide' }, 400, origin);

  const item = await env.relinkdb.prepare('SELECT * FROM shop_items WHERE id = ?').bind(id).first();
  if (!item) return json({ error: 'Article introuvable' }, 404, origin);
  if (!item.visible || !item.purchasable)
    return json({ error: "Cet article n'est pas disponible à l'achat" }, 400, origin);

  if (item.max_total != null && item.purchased_total + qty > item.max_total)
    return json({ error: 'Stock épuisé pour cet article' }, 409, origin);

  if (item.max_per_player != null) {
    const owned = await env.relinkdb.prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS n FROM shop_purchases
       WHERE discord_id = ? AND item_id = ? AND status != 'cancelled'`
    ).bind(payload.discord_id, id).first();
    if ((owned?.n || 0) + qty > item.max_per_player)
      return json({ error: 'Limite par joueur atteinte pour cet article' }, 409, origin);
  }

  const unitPrice = (item.promo_active && item.promo_price != null) ? item.promo_price : item.price_eclats;
  const totalCost = unitPrice * qty;

  const user = await env.relinkdb.prepare('SELECT eclats FROM users WHERE discord_id = ?').bind(payload.discord_id).first();
  if (!user) return json({ error: 'Utilisateur introuvable' }, 404, origin);
  if ((user.eclats || 0) < totalCost) return json({ error: 'Solde insuffisant' }, 402, origin);

  const newBalance = user.eclats - totalCost;
  await env.relinkdb.batch([
    env.relinkdb.prepare('UPDATE users SET eclats = ? WHERE discord_id = ?').bind(newBalance, payload.discord_id),
    env.relinkdb.prepare(
      `INSERT INTO eclats_transactions (discord_id, amount, reason, balance_after, meta, created_at)
       VALUES (?, ?, 'shop_purchase', ?, ?, datetime('now'))`
    ).bind(payload.discord_id, -totalCost, newBalance, JSON.stringify({ item_id: Number(id), quantity: qty })),
    env.relinkdb.prepare(
      `INSERT INTO shop_purchases (discord_id, item_id, quantity, eclats_spent, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', datetime('now'))`
    ).bind(payload.discord_id, id, qty, totalCost),
    env.relinkdb.prepare('UPDATE shop_items SET purchased_total = purchased_total + ? WHERE id = ?').bind(qty, id),
  ]);

  return json({ ok: true, item: item.name, quantity: qty, spent: totalCost, balance: newBalance }, 200, origin);
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

      // ── Liaison compte Minecraft via /link ────────────────────────────────
      if (request.method === 'POST' && pathname === '/mc/link/request') return await handleLinkRequest(request, env, origin);
      if (request.method === 'GET'  && pathname === '/mc/link/status')  return await handleLinkStatus(request, env, origin);
      if (request.method === 'POST' && pathname === '/link/confirm')    return await handleLinkConfirm(request, env, origin);

      const submissionType = extractSubmissionType(pathname);
      if (submissionType) {
        if (request.method === 'GET')    return await handleGetSubmission(request, env, origin, submissionType);
        if (request.method === 'POST')   return await handlePostSubmission(request, env, origin, submissionType);
        if (request.method === 'DELETE') return await handleDeleteSubmission(request, env, origin, submissionType);
      }

      // ── Formulaires → Discord ──────────────────────────────────────────────
      const formMatch = pathname.match(/^\/forms\/([a-z]+)$/);
      if (formMatch && request.method === 'POST')
        return await handleFormSubmit(request, env, origin, formMatch[1]);

      // ── Boutique publique ──────────────────────────────────────────────────
      if (request.method === 'GET' && pathname === '/shop') return await handleGetShop(env, origin);

      // ── Routes admin / flags ──────────────────────────────────────────────
      if (request.method === 'GET'  && pathname === '/flags')              return await handleGetFlags(env, origin);
      if (request.method === 'GET'  && pathname === '/admin/users')        return await handleAdminGetUsers(request, env, origin);
      if (request.method === 'GET'  && pathname === '/admin/flags')        return await handleAdminGetFlags(request, env, origin);
      if (request.method === 'POST' && pathname === '/admin/flags')        return await handleAdminSetFlag(request, env, origin);
      if (request.method === 'GET'  && pathname === '/admin/submissions')  return await handleAdminGetSubmissions(request, env, origin);

      const adminUserMatch = pathname.match(/^\/admin\/users\/([^/]+)\/status$/);
      if (adminUserMatch && request.method === 'POST')
        return await handleAdminUserStatus(request, env, origin, adminUserMatch[1]);

      const adminForceLinkMatch = pathname.match(/^\/admin\/users\/([^/]+)\/force-link$/);
      if (adminForceLinkMatch && request.method === 'POST')
        return await handleAdminForceLink(request, env, origin, adminForceLinkMatch[1]);

      // ── Routes admin — Éclats & Boutique (NOUVEAU v9) ──────────────────────
      if (request.method === 'POST' && pathname === '/admin/eclats/grant')   return await handleAdminGrantEclats(request, env, origin);
      if (request.method === 'POST' && pathname === '/admin/eclats/partner') return await handleAdminSetPartner(request, env, origin);
      if (request.method === 'GET'  && pathname === '/admin/shop')           return await handleAdminGetShop(request, env, origin);
      if (request.method === 'POST' && pathname === '/admin/shop')           return await handleAdminCreateShopItem(request, env, origin);

      const shopItemMatch = pathname.match(/^\/admin\/shop\/(\d+)$/);
      if (shopItemMatch && request.method === 'PUT')    return await handleAdminUpdateShopItem(request, env, origin, shopItemMatch[1]);
      if (shopItemMatch && request.method === 'DELETE') return await handleAdminDeleteShopItem(request, env, origin, shopItemMatch[1]);

      const shopGrantMatch = pathname.match(/^\/admin\/shop\/(\d+)\/grant$/);
      if (shopGrantMatch && request.method === 'POST') return await handleAdminGrantShopItem(request, env, origin, shopGrantMatch[1]);

      // ── Admin — suivi des commandes boutique (NOUVEAU v11) ─────────────────
      if (request.method === 'GET' && pathname === '/admin/shop/purchases')
        return await handleAdminGetShopPurchases(request, env, origin);

      const purchaseStatusMatch = pathname.match(/^\/admin\/shop\/purchases\/(\d+)\/status$/);
      if (purchaseStatusMatch && request.method === 'POST')
        return await handleAdminUpdatePurchaseStatus(request, env, origin, purchaseStatusMatch[1]);

      if (request.method === 'DELETE' && pathname === '/admin/shop/purchases/purge')
        return await handleAdminPurgePastPurchases(request, env, origin);

      const purchaseDeleteMatch = pathname.match(/^\/admin\/shop\/purchases\/(\d+)$/);
      if (purchaseDeleteMatch && request.method === 'DELETE')
        return await handleAdminDeletePurchase(request, env, origin, purchaseDeleteMatch[1]);

      // ── Calendrier de streak — configurable (NOUVEAU v12) ───────────────────
      if (request.method === 'GET' && pathname === '/streak/config')
        return await handleGetStreakConfig(request, env, origin);
      if (request.method === 'GET' && pathname === '/admin/streak-config')
        return await handleAdminGetStreakConfig(request, env, origin);
      if (request.method === 'PUT' && pathname === '/admin/streak-config')
        return await handleAdminUpdateStreakConfig(request, env, origin);

      // ── Routes site — Éclats, parrainage, streak, achats (NOUVEAU v10) ─────
      if (request.method === 'GET'  && pathname === '/rewards/summary')          return await handleRewardsSummary(request, env, origin);
      if (request.method === 'POST' && pathname === '/referral/redeem')          return await handleReferralRedeem(request, env, origin);
      if (request.method === 'GET'  && pathname === '/leaderboard/referrals')    return await handleReferralLeaderboard(request, env, origin);
      if (request.method === 'GET'  && pathname === '/leaderboard/streak')       return await handleStreakLeaderboard(request, env, origin);
      if (request.method === 'GET'  && pathname === '/shop/purchases/me')        return await handleShopPurchasesMe(request, env, origin);

      const shopPurchaseMatch = pathname.match(/^\/shop\/(\d+)\/purchase$/);
      if (shopPurchaseMatch && request.method === 'POST') return await handleShopPurchase(request, env, origin, shopPurchaseMatch[1]);

      return json({ error: 'Route inconnue' }, 404, origin);
    } catch(e) {
      console.error(e);
      return json({ error: e.message || 'Erreur interne' }, 500, origin);
    }
  },
};