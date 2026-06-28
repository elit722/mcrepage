"""
collect_stats.py
Lit les fichiers stats Minecraft + playerdata NBT via l'API Pterodactyl
et envoie les classements au Worker Cloudflare.

Dépendances : pip install requests nbtlib
Variables d'environnement (GitHub Secrets) :
  PTERO_URL       https://game.lordhosting.fr
  PTERO_API_KEY       ptlc_...
  PTERO_SERVER    1798a4bf
  WORKER_URL      https://relink-auth.refugeemeraudien-direction.workers.dev
  STATS_SECRET    clé secrète partagée avec le Worker
"""

import os, json, io, gzip, requests
import nbtlib

PTERO_URL    = os.environ['PTERO_URL']
PTERO_API_KEY    = os.environ['PTERO_API_KEY']
PTERO_SERVER = os.environ['PTERO_SERVER']
WORKER_URL   = os.environ['WORKER_URL']
STATS_SECRET = os.environ['STATS_SECRET']

HEADERS = {
    'Authorization': f'Bearer {PTERO_API_KEY}',
    'Accept': 'application/vnd.pterodactyl.v1+json',
}

BASE = f'{PTERO_URL}/api/client/servers/{PTERO_SERVER}'


def ptero_file(path: str) -> bytes:
    r = requests.get(f'{BASE}/files/contents', params={'file': path}, headers=HEADERS, timeout=15)
    r.raise_for_status()
    return r.content


def ptero_list(path: str) -> list:
    r = requests.get(f'{BASE}/files/list', params={'directory': path}, headers=HEADERS, timeout=15)
    r.raise_for_status()
    return r.json()['data']


def get_usercache() -> dict:
    try:
        data = ptero_file('/usercache.json')
        cache = json.loads(data)
        return {entry['uuid']: entry['name'] for entry in cache}
    except Exception as e:
        print(f'[WARN] usercache.json inaccessible : {e}')
        return {}


def get_mc_stats(uuid: str) -> dict:
    try:
        data = ptero_file(f'/world/stats/{uuid}.json')
        stats = json.loads(data).get('stats', {})
        kills = stats.get('minecraft:killed', {}).get('minecraft:player', 0)
        used = stats.get('minecraft:used', {})
        blocs_poses = sum(used.values())
        return {'kills': kills, 'blocs_poses': blocs_poses}
    except Exception as e:
        print(f'[WARN] Stats {uuid} : {e}')
        return {'kills': 0, 'blocs_poses': 0}


def get_numismatic_balance(uuid: str) -> int:
    """
    Lit world/playerdata/UUID.dat (NBT gzip) et extrait la balance Numismatic.
    nbtlib 2.x : utilise nbtlib.File.parse() sur un BytesIO décompressé.
    """
    try:
        raw = ptero_file(f'/world/playerdata/{uuid}.dat')

        # Décompresse manuellement si gzip
        try:
            raw = gzip.decompress(raw)
        except Exception:
            pass  # Pas gzip, on utilise les bytes bruts

        nbt = nbtlib.File.parse(io.BytesIO(raw))

        # Affiche les clés pour debug
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


def collect():
    print('→ Récupération de usercache.json…')
    usercache = get_usercache()

    print('→ Listage de world/stats/…')
    try:
        files = ptero_list('/world/stats')
    except Exception as e:
        print(f'[ERROR] Impossible de lister world/stats : {e}')
        return

    players = []
    for f in files:
        name = f['attributes']['name']
        if not name.endswith('.json'):
            continue
        uuid = name.replace('.json', '')
        pseudo = usercache.get(uuid, uuid[:8])

        print(f'  · {pseudo} ({uuid})')
        mc      = get_mc_stats(uuid)
        fortune = get_numismatic_balance(uuid)

        players.append({
            'uuid':        uuid,
            'pseudo':      pseudo,
            'kills':       mc['kills'],
            'blocs_poses': mc['blocs_poses'],
            'fortune':     fortune,
        })

    if not players:
        print('[WARN] Aucun joueur trouvé.')
        return

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
    print(f'✅ Worker répond : {r.json()}')


if __name__ == '__main__':
    collect()
