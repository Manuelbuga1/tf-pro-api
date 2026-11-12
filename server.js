const express = require('express');
const app = express();

const API_KEY = process.env.RIOT_API_KEY;
const RIOT_ID = 'Right Click';
const TAG = '133';
const BASE = 'https://na1.api.riotgames.com';
const ACCOUNTS_BASE = 'https://americas.api.riotgames.com';
const PROS_URL = 'https://www.trackingthepros.com/d/list_players';

let cachedPuuid = null;
let proList = {};
let proListLastFetch = 0;
const CACHE_MS = 30 * 60 * 1000;

const PROS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.trackingthepros.com/players'
};

let currentGame = {
  myChamp: '',
  allies: [],
  enemies: [],
  pros: [],
  scanning: false,
  scanDone: false
};

// === FETCH PRO LIST ===
async function fetchProList() {
  try {
    const res = await fetch(PROS_URL, { headers: PROS_HEADERS });
    const data = await res.json();
    const arr = data.data || [];

    if (arr.length > 0) {
      console.log('PRO KEYS:', Object.keys(arr[0]).join(', '));
      console.log('PRO SAMPLE:', JSON.stringify(arr[0]).substring(0, 600));
    }

    const newList = {};
    for (const p of arr) {
      if (p.name) {
        newList[p.name.toLowerCase()] = {
          name: p.name,
          position: p.position || '',
          tagline: p.tagline || p.tag || p.game_tag || p.riot_tag || '',
          current_region: p.current_region || '',
          online: p.online || false
        };
      }
    }
    proList = newList;
    proListLastFetch = Date.now();
    console.log(`Pro list: ${Object.keys(proList).length} players`);
  } catch (e) {
    console.error('Pro list error:', e.message);
  }
}

// === CHAMPION NAMES ===
let championNames = {};
async function getChampionNames() {
  if (Object.keys(championNames).length > 0) return championNames;
  const res = await fetch('https://ddragon.leagueoflegends.com/cdn/data/en_US/champion.json');
  const data = await res.json();
  for (const key in data.data) {
    championNames[data.data[key].id] = data.data[key].name;
  }
  return championNames;
}

// === PUUID CACHE ===
let puuidCache = {};
async function getPuuid(gameName, tagline) {
  const key = gameName.toLowerCase() + '#' + tagline.toLowerCase();
  if (puuidCache[key]) return puuidCache[key];
  try {
    const res = await fetch(
      `${ACCOUNTS_BASE}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagline)}`,
      { headers: { 'X-Riot-Token': API_KEY } }
    );
    if (res.ok) {
      const d = await res.json();
      puuidCache[key] = d.puuid;
      return d.puuid;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// === FLEXIBLE MATCHING ===
// Returns: 'our_team', 'enemy_team', or null
// Works even if some participants are missing (streamer mode)
function matchGame(participants, proPuuid, names, myChamps, enemyChamps) {
  const proInGame = participants.find(p => p.puuid === proPuuid);
  if (!proInGame) return null;

  const proTeamId = proInGame.teamId;

  // Get champions we can actually see
  const proTeamChamps = participants
    .filter(p => p.teamId === proTeamId)
    .map(p => (names[p.championId] || '').toLowerCase())
    .filter(c => c !== '');

  const enemyTeamChamps = participants
    .filter(p => p.teamId !== proTeamId)
    .map(p => (names[p.championId] || '').toLowerCase())
    .filter(c => c !== '');

  // Check pro's team against our allies
  const proTeamMatchesAllies = proTeamChamps.length > 0 &&
    proTeamChamps.every(c => myChamps.includes(c));

  // Check pro's team against our enemies
  const proTeamMatchesEnemies = proTeamChamps.length > 0 &&
    proTeamChamps.every(c => enemyChamps.includes(c));

  // Check enemy team against our allies
  const enemyTeamMatchesAllies = enemyTeamChamps.length > 0 &&
    enemyTeamChamps.every(c => myChamps.includes(c));

  // Check enemy team against our enemies
  const enemyTeamMatchesEnemies = enemyTeamChamps.length > 0 &&
    enemyTeamChamps.every(c => enemyChamps.includes(c));

  // Determine which side the pro is on
  if (proTeamMatchesAllies) return 'our_team';
  if (proTeamMatchesEnemies) return 'enemy_team';
  if (enemyTeamMatchesAllies) return 'enemy_team'; // pro is on enemy side
  if (enemyTeamMatchesEnemies) return 'our_team'; // pro is on our side

  return null;
}

// === SCAN FOR GAME ===
async function scanForGame() {
  if (currentGame.scanning) return;
  if (!currentGame.myChamp) return;

  currentGame.scanning = true;
  currentGame.scanDone = false;
  currentGame.pros = [];

  const names = await getChampionNames();
  const myChamps = [currentGame.myChamp, ...currentGame.allies].map(c => c.toLowerCase());
  const enemyChamps = currentGame.enemies.map(c => c.toLowerCase());

  // Get NA online pros with tagline
  const naPros = [];
  for (const key in proList) {
    const p = proList[key];
    if (p.current_region === 'NA' && p.online && p.tagline) {
      naPros.push(p);
    }
  }
  console.log(`Scanning ${naPros.length} NA online pros with tagline...`);

  for (const pro of naPros) {
    try {
      const puuid = await getPuuid(pro.name, pro.tagline);
      if (!puuid) continue;

      await sleep(500);

      const specRes = await fetch(
        `${BASE}/lol/spectator/v5/active-games/by-summoner/${puuid}`,
        { headers: { 'X-Riot-Token': API_KEY } }
      );

      if (specRes.status === 404 || specRes.status === 403) continue;
      if (specRes.status === 429) {
        console.log('Rate limited during scan, stopping.');
        break;
      }
      if (!specRes.ok) continue;

      const game = await specRes.json();
      const participants = game.participants || [];

      if (participants.length < 3) continue;

      const side = matchGame(participants, puuid, names, myChamps, enemyChamps);
      if (side) {
        const proInGame = participants.find(p => p.puuid === puuid);
        currentGame.pros.push({
          name: pro.name,
          position: pro.position,
          side: side,
          champ: names[proInGame.championId] || '???'
        });
        console.log(`Found pro: ${pro.name} [${pro.position}] on ${side} team (${names[proInGame.championId]})`);
      }

    } catch (e) { /* ignore */ }
  }

  currentGame.scanning = false;
  currentGame.scanDone = true;
  console.log(`Scan done. Found ${currentGame.pros.length} pro players.`);
}

// === SET CHAMPS ===
app.get('/setchamps', async (req, res) => {
  const data = req.query.data || '';
  const parts = data.split('|').map(s => s.trim());

  if (parts.length === 1) {
    const champs = parts[0].split(',').map(c => c.trim()).filter(Boolean);
    currentGame.myChamp = champs[0] || '';
    currentGame.allies = champs.slice(1);
    currentGame.enemies = [];
  } else if (parts.length === 2) {
    const allies = parts[0].split(',').map(c => c.trim()).filter(Boolean);
    const enemies = parts[1].split(',').map(c => c.trim()).filter(Boolean);
    currentGame.myChamp = allies[0] || '';
    currentGame.allies = allies.slice(1);
    currentGame.enemies = enemies;
  } else {
    return res.send('Invalid format. Use: Ally1, Ally2, Ally3, Ally4, Ally5 | Enemy1, Enemy2, Enemy3, Enemy4, Enemy5');
  }

  currentGame.pros = [];
  currentGame.scanDone = false;
  scanForGame();

  res.send(`Champions set: ${currentGame.myChamp} | ${currentGame.allies.join(', ')} vs ${currentGame.enemies.join(', ')} - Scanning for pros...`);
});

// === SET PROS (manual) ===
app.get('/setpro', async (req, res) => {
  const data = req.query.data || '';
  const entries = data.split(',').map(e => e.trim()).filter(Boolean);
  const pros = [];
  for (const entry of entries) {
    const [name, champ] = entry.split(':').map(s => s.trim());
    if (name) {
      const proInfo = proList[name.toLowerCase()];
      pros.push({
        name: name,
        champ: champ || '',
        position: proInfo ? proInfo.position : '',
        side: 'unknown'
      });
    }
  }
  currentGame.pros = pros;
  currentGame.scanDone = true;
  res.send('Pro players set: ' + pros.map(p => `${p.name} (${p.champ})`).join(', '));
});

// === CLEAR ===
app.get('/clear', async (req, res) => {
  currentGame = { myChamp: '', allies: [], enemies: [], pros: [], scanning: false, scanDone: false };
  res.send('Game cleared');
});

// === PRO ===
app.get('/pro', async (req, res) => {
  if (currentGame.myChamp) {
    let result = `TF Blade: ${currentGame.myChamp}`;
    if (currentGame.allies.length > 0) result += ` | Team: ${currentGame.allies.join(', ')}`;
    if (currentGame.enemies.length > 0) result += ` | Enemies: ${currentGame.enemies.join(', ')}`;

    if (currentGame.scanning) {
      result += ' | Scanning for pro players...';
    } else if (currentGame.pros.length > 0) {
      const allies = currentGame.pros.filter(p => p.side === 'our_team');
      const enemies = currentGame.pros.filter(p => p.side === 'enemy_team');
      const unknown = currentGame.pros.filter(p => p.side === 'unknown');
      if (allies.length > 0) result += ` | PRO Allies: ${allies.map(p => `${p.name} [${p.position}] (${p.champ})`).join(', ')}`;
      if (enemies.length > 0) result += ` | PRO Enemies: ${enemies.map(p => `${p.name} [${p.position}] (${p.champ})`).join(', ')}`;
      if (unknown.length > 0) result += ` | PRO: ${unknown.map(p => `${p.name} (${p.champ})`).join(', ')}`;
    } else if (currentGame.scanDone) {
      result += ' | No pro players found in game';
    } else {
      result += ' | Waiting for scan...';
    }

    return res.send(result);
  }

  // No manual set - try Spectator API directly
  try {
    if (Date.now() - proListLastFetch > CACHE_MS) await fetchProList();

    if (!cachedPuuid) {
      const accRes = await fetch(
        `${ACCOUNTS_BASE}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(RIOT_ID)}/${TAG}`,
        { headers: { 'X-Riot-Token': API_KEY } }
      );
      if (!accRes.ok) return res.send('Riot API error: ' + accRes.status);
      cachedPuuid = (await accRes.json()).puuid;
    }

    const specRes = await fetch(
      `${BASE}/lol/spectator/v5/active-games/by-summoner/${cachedPuuid}`,
      { headers: { 'X-Riot-Token': API_KEY } }
    );

    if (specRes.status === 404) return res.send('Not in a game right now');
    if (specRes.status === 429) return res.send('Rate limited, try again');
    if (!specRes.ok) return res.send('Spectator API error: ' + specRes.status);

    const game = await specRes.json();
    const names = await getChampionNames();
    const me = game.participants.find(p => p.puuid === cachedPuuid);
    if (!me) return res.send('Not in a game right now');

    const myTeam = me.teamId;
    const allies = [];
    const enemies = [];
    for (const p of game.participants) {
      if (p.puuid === cachedPuuid) continue;
      const gameName = p.riotId?.gameName || '';
      const pro = proList[gameName.toLowerCase()];
      if (pro) {
        const entry = { name: pro.name, position: pro.position, champ: names[p.championId] || '???' };
        if (p.teamId === myTeam) allies.push(entry);
        else enemies.push(entry);
      }
    }

    let result = `TF Blade: ${names[me.championId] || '???'}`;
    if (allies.length > 0) result += ` | PRO Allies: ${allies.map(a => `${a.name} [${a.position}] (${a.champ})`).join(', ')}`;
    if (enemies.length > 0) result += ` | PRO Enemies: ${enemies.map(e => `${e.name} [${e.position}] (${e.champ})`).join(', ')}`;
    if (allies.length === 0 && enemies.length === 0) result += ' | No pro players in game';
    return res.send(result);
  } catch (e) {
    return res.send('Error: ' + e.message);
  }
});

fetchProList();
app.listen(3000, () => console.log('Running'));   
