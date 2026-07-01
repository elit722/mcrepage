"""
collect_stats.py
Lit les fichiers stats Minecraft + playerdata NBT + FTBTeams + ClanMod via l'API Pterodactyl
et envoie les classements au Worker Cloudflare.

Dépendances : pip install requests nbtlib
Variables d'environnement (GitHub Secrets) :
  PTERO_URL       https://game.lordhosting.fr
  PTERO_API_KEY   ptlc_...
  PTERO_SERVER    1798a4bf
  WORKER_URL      https://relink-auth.refugeemeraudien-direction.workers.dev
  STATS_SECRET    clé secrète partagée avec le Worker
"""

import os, json, io, gzip, re, requests
import nbtlib

PTERO_URL     = os.environ['PTERO_URL']
PTERO_API_KEY = os.environ['PTERO_API_KEY']
PTERO_SERVER  = os.environ['PTERO_SERVER']
WORKER_URL    = os.environ['WORKER_URL']
STATS_SECRET  = os.environ['STATS_SECRET']

# Noms reconnus comme dynasties (insensible à la casse, correspondance partielle)
DYNASTY_SUSAKU = 'susaku'
DYNASTY_SEIRYU = 'seiryu'

HEADERS = {
    'Authorization': f'Bearer {PTERO_API_KEY}',
    'Accept': 'application/vnd.pterodactyl.v1+json',
}

BASE = f'{PTERO_URL}/api/client/servers/{PTERO_SERVER}'


# ── API Pterodactyl ──────────────────────────────────────────────────────────

def ptero_file(path: str) -> bytes:
    r = requests.get(f'{BASE}/files/contents', params={'file': path}, headers=HEADERS, timeout=15)
    r.raise_for_status()
    return r.content


def ptero_list(path: str) -> list:
    r = requests.get(f'{BASE}/files/list', params={'directory': path}, headers=HEADERS, timeout=15)
    r.raise_for_status()
    return r.json()['data']


# ── Parser SNBT maison ───────────────────────────────────────────────────────
# Le format SNBT de FTBTeams n'est pas du JSON standard (pas de guillemets sur
# les clés UUID, suffixes de type NBT comme 0b / 1000L, etc.).
# On extrait uniquement les deux champs dont on a besoin par regex.

def parse_snbt(text: str) -> dict:
    """
    Extrait depuis un fichier SNBT FTBTeams :
      - display_name  : valeur de "ftbteams:display_name"
      - member_uuids  : liste des UUID présents dans le bloc ranks { ... }
    """
    result = {'display_name': None, 'member_uuids': []}

    # display_name
    m = re.search(r'"ftbteams:display_name"\s*:\s*"([^"]*)"', text)
    if m:
        result['display_name'] = m.group(1)

    # ranks { uuid: "role"  uuid: "role" ... }
    ranks_m = re.search(r'\branks\s*:\s*\{([^}]*)\}', text, re.DOTALL)
    if ranks_m:
        ranks_block = ranks_m.group(1)
        uuids = re.findall(
            r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
            ranks_block
        )
        result['member_uuids'] = uuids

    return result


# ── FTBTeams : construction de la map uuid → dynasty ────────────────────────

def get_dynasty_map() -> dict:
    """
    Lit tous les fichiers .snbt dans world/ftbteams/party/,
    identifie les équipes Susaku et Seiryu,
    et retourne un dict { uuid: 'susaku' | 'seiryu' }.
    Tous les UUID absents de ce dict n'ont pas de dynasty (None).
    """
    dynasty_map = {}

    try:
        party_files = ptero_list('/world/ftbteams/party')
    except Exception as e:
        print(f'[WARN] Impossible de lister world/ftbteams/party : {e}')
        return dynasty_map

    for f in party_files:
        fname = f['attributes']['name']
        if not fname.endswith('.snbt'):
            continue

        try:
            raw = ptero_file(f'/world/ftbteams/party/{fname}')
            text = raw.decode('utf-8', errors='replace')
            info = parse_snbt(text)

            name_lower = (info['display_name'] or '').lower()

            if DYNASTY_SUSAKU in name_lower:
                dynasty = 'susaku'
            elif DYNASTY_SEIRYU in name_lower:
                dynasty = 'seiryu'
            else:
                print(f'  [FTBTEAMS] Équipe ignorée : "{info["display_name"]}" ({fname})')
                continue

            print(f'  [FTBTEAMS] {fname} → {dynasty} ({len(info["member_uuids"])} membre(s))')
            for uuid in info['member_uuids']:
                dynasty_map[uuid] = dynasty

        except Exception as e:
            print(f'  [WARN] Lecture party/{fname} : {e}')

    return dynasty_map


# ── Stats Minecraft ──────────────────────────────────────────────────────────

def get_usercache() -> dict:
    try:
        data = ptero_file('/usercache.json')
        cache = json.loads(data)
        return {entry['uuid']: entry['name'] for entry in cache}
    except Exception as e:
        print(f'[WARN] usercache.json inaccessible : {e}')
        return {}


def get_mc_stats(uuid: str) -> dict:
    """
    Lit world/stats/UUID.json et retourne kills, deaths, blocs_poses.
    Utilise .get(..., 0) partout : un joueur peut ne jamais avoir déclenché
    une stat donnée (ex : jamais mort), auquel cas la clé est absente du JSON
    plutôt qu'à 0. Un accès direct type stats['minecraft:custom']['minecraft:deaths']
    provoquerait alors un KeyError.
    """
    try:
        data = ptero_file(f'/world/stats/{uuid}.json')
        stats = json.loads(data).get('stats', {})

        kills = stats.get('minecraft:killed', {}).get('minecraft:player', 0)

        # Le compteur de morts total vit sous minecraft:custom, pas sous
        # minecraft:killed (qui ne contient que les mobs/joueurs tués PAR ce joueur).
        deaths = stats.get('minecraft:custom', {}).get('minecraft:deaths', 0)

        used = stats.get('minecraft:used', {})
        blocs_poses = sum(used.values()) if used else 0

        return {'kills': kills, 'deaths': deaths, 'blocs_poses': blocs_poses}
    except Exception as e:
        print(f'[WARN] Stats {uuid} : {e}')
        return {'kills': 0, 'deaths': 0, 'blocs_poses': 0}


def get_numismatic_balance(uuid: str) -> int:
    """
    Lit world/playerdata/UUID.dat (NBT gzip) et extrait la balance Numismatic.
    """
    try:
        raw = ptero_file(f'/world/playerdata/{uuid}.dat')

        try:
            raw = gzip.decompress(raw)
        except Exception:
            pass  # Pas gzip, on utilise les bytes bruts

        nbt = nbtlib.File.parse(io.BytesIO(raw))

        print(f'  [NBT] clés racine : {list(nbt.keys())[:8]}')

        components = nbt.get('cardinal_components', {})
        if components:
            print(f'  [NBT] clés cardinal_components : {list(components.keys())}')
        currency = components.get('numismatic-overhaul:currency', {})
        value = int(currency.get('Value', 0))
        print(f'  [NBT] fortune={value}')
        return value

    except Exception as e:
        print(f'[WARN] NBT {uuid} : {e}')
        return 0


# ── ClanMod : lecture de clans.json ─────────────────────────────────────────

def get_clans() -> list:
    """
    Lit /config/clanmod/clans.json et retourne la liste brute des clans.
    """
    try:
        data = ptero_file('/config/clanmod/clans.json')
        clans = json.loads(data)
        print(f'  [CLANS] {len(clans)} clan(s) trouvé(s).')
        return clans
    except Exception as e:
        print(f'[WARN] clans.json inaccessible : {e}')
        return []


# ── Collecte principale ──────────────────────────────────────────────────────

def collect():
    print('→ Récupération de usercache.json…')
    usercache = get_usercache()

    print('→ Lecture des équipes FTBTeams…')
    dynasty_map = get_dynasty_map()
    print(f'  {len(dynasty_map)} joueur(s) assigné(s) à une dynasty.')

    print('→ Listage de world/stats/…')
    try:
        files = ptero_list('/world/stats')
    except Exception as e:
        print(f'[ERROR] Impossible de lister world/stats : {e}')
        return

    # ── Joueurs ──
    players = []
    for f in files:
        name = f['attributes']['name']
        if not name.endswith('.json'):
            continue

        uuid   = name.replace('.json', '')
        pseudo = usercache.get(uuid, uuid[:8])

        dynasty = dynasty_map.get(uuid, None)
        dynasty_label = {
            'susaku': 'Susaku',
            'seiryu': 'Seiryu',
            None:     'Sans équipe',
        }[dynasty]

        print(f'  · {pseudo} ({uuid}) — {dynasty_label}')

        mc      = get_mc_stats(uuid)
        fortune = get_numismatic_balance(uuid)

        players.append({
            'uuid':        uuid,
            'pseudo':      pseudo,
            'kills':       mc.get('kills', 0),
            'deaths':      mc.get('deaths', 0),
            'blocs_poses': mc.get('blocs_poses', 0),
            'fortune':     fortune,
            'dynasty':     dynasty,
        })

    if not players:
        print('[WARN] Aucun joueur trouvé.')
    else:
        print(f'→ Envoi de {len(players)} joueur(s) au Worker…')
        r = requests.post(
            f'{WORKER_URL}/stats',
            json={'players': players},
            headers={
                'Content-Type': 'application/json',
                'X-Stats-Secret': STATS_SECRET,
            },
            timeout=15,
        )
        r.raise_for_status()
        print(f'✅ Stats joueurs — Worker répond : {r.json()}')

    # ── Clans ──
    print('→ Lecture de clans.json (ClanMod)…')
    clans = get_clans()

    if not clans:
        print('[WARN] Aucun clan trouvé, sync ignorée.')
    else:
        print(f'→ Envoi de {len(clans)} clan(s) au Worker…')
        r2 = requests.post(
            f'{WORKER_URL}/clans-sync',
            json={'clans': clans},
            headers={
                'Content-Type': 'application/json',
                'X-Stats-Secret': STATS_SECRET,
            },
            timeout=15,
        )
        r2.raise_for_status()
        print(f'✅ Clans — Worker répond : {r2.json()}')


if __name__ == '__main__':
    collect()