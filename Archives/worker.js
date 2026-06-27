const PANEL = "https://game.lordhosting.fr";
const API_KEY = "ptlc_BengXWpSK07pVYo6aMACJikkmjkTEsNy1xYqf7JlevB";
const SERVER_ID = "1798a4bf";

// Adresse IP ou domaine de ton serveur Minecraft (visible dans le panel)
// Exemple : "play.tonserveur.fr" ou "123.456.789.0"
const MC_HOST   = "gm1.lordhosting.fr";
const MC_PORT   = 2062;
 
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET",
  "Content-Type": "application/json"
};
 
async function pterodactyl(path) {
  const r = await fetch(`${PANEL}/api/client/servers/${SERVER_ID}${path}`, {
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Accept": "Application/vnd.pterodactyl.v1+json"
    }
  });
  if (!r.ok) throw new Error(`Pterodactyl ${r.status}`);
  return r.json();
}
 
// Utilise l'API publique mcstatus.io pour le query
// (Cloudflare Workers ne peuvent pas ouvrir de sockets UDP — on délègue à mcstatus.io)
async function minecraftStatus() {
  try {
    const r = await fetch(`https://api.mcstatus.io/v2/status/java/${MC_HOST}:${MC_PORT}`, {
      headers: { "Accept": "application/json" }
    });
    if (!r.ok) return null;
    const data = await r.json();
    return {
      online: data.online,
      current: data.online ? data.players.online : 0,
      max: data.online ? data.players.max : null
    };
  } catch {
    return null;
  }
}
 
export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
 
    try {
      // Appels en parallèle
      const [info, resources, mc] = await Promise.all([
        pterodactyl(""),
        pterodactyl("/resources"),
        minecraftStatus()
      ]);
 
      const limits = info.attributes.limits;
      const stats  = resources.attributes.resources;
 
      const data = {
        status: resources.attributes.current_state,
        players: {
          current: mc ? mc.current : null,
          max:     mc ? mc.max     : limits.feature_limits?.allocations || 50
        },
        ram: {
          used_mb:  Math.round(stats.memory_bytes / 1024 / 1024),
          limit_mb: limits.memory
        },
        cpu_percent:   Math.round(stats.cpu_absolute * 10) / 10,
        cpu_limit:     limits.cpu || 100,
        disk_mb:       Math.round(stats.disk_bytes / 1024 / 1024),
        disk_limit_mb: limits.disk || null
      };
 
      return new Response(JSON.stringify(data), { headers: CORS });
 
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: CORS
      });
    }
  }
};
