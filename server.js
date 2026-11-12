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

async function fetchProList() {
  try {
    const res = await fetch(PROS_URL, { headers: PROS_HEADERS });
    const data = await res.json();
    const arr = data.data || [];

    // DEBUG: vezi ce e in player_accounts
    const withAccounts = arr.filter(p => p.player_accounts);
    if (withAccounts.length > 0) {
      console.log('PLAYER_ACCOUNTS SAMPLE:', JSON.stringify(withAccounts[0].player_accounts).substring(0, 500));
      console.log('PLAYER_ACCOUNTS TYPE:', typeof withAccounts[0].player_accounts);
    } else {
      console.log('NO player_accounts found in any player');
    }

    const newList = {};
    for (const p of arr) {
      if (p.name) {
        newList[p.name.toLowerCase()] = {
          name: p.name,
          position: p.position || '',
          team_name: p.team_name || '',
          current_region: p.current_region || '',
          player_accounts: p.player_accounts || null
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

let puuidCache = {};
async function getPuuid(gameName, tagline) {
  const key = gameName.toLowerCase() + '#' + tagline.toLowerCase();
  if (puuidCache[key]) return puuidCache[key];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `${ACCOUNTS_BASE}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagline)}`,
      { headers: { 'X-Riot-Token': API_KEY }, signal: controller.signal }
    );
    clearTimeout(timeout);
    if (res.ok) {
      const d = await res.json();
      puuidCache[key] = d.puuid;
      return d.puuid;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function matchGame(participants, proPuuid, names, myChamps, enemyChamps) {
  const proInGame = participants.find(p => p.puuid === proPuuid);
  if (!proInGame) return null;

  const proTeamId = proInGame.teamId;
  const proTeamChamps = participants
    .filter(p => p.teamId === proTeamId)
    .map(p => (names[p.championId] || '').toLowerCase())
    .filter(c => c !== '');
  const enemyTeamChamps = participants
    .filter(p => p.teamId !== proTeamId)
    .map(p => (names[p.championId] || '').toLowerCase())
    .filter(c => c !== '');

  if (proTeamChamps.length > 0 && proTeamChamps.every(c => myChamps.includes(c))) return 'our_team';
  if (proTeamChamps.length > 0 && proTeamChamps.every(c => enemyChamps.includes(c))) return 'enemy_team';
  if (enemyTeamChamps.length > 0 && enemyTeamChamps.every(c => myChamps.includes(c))) return 'enemy_team';
  if (enemyTeamChamps.length > 0 && enemyTeamChamps.every(c => enemyChamps.includes(c))) return 'our_team';
  return null;
}

async function scanForGame() {
  if (currentGame.scanning) return;
  if (!currentGame.myChamp) return;

  currentGame.scanning = true;
  currentGame.scanDone = false;
  currentGame.pros = [];

  const names = await getChampionNames();
  const myChamps = [currentGame.myChamp, ...currentGame.allies].map(c => c.toLowerCase());
  const enemyChamps = currentGame.enemies.map(c => c.toLowerCase());

  const naPros = [];
  for (const key in proList) {
    const p = proList[key];
    if (p.current_region === 'NA' && p.player_accounts) {
      naPros.push(p);
    }
  }
  console.log(`Scanning ${naPros.length} NA pros with player_accounts...`);

  const SCAN_TIMEOUT = 45000; // 45 sec max
  const startTime = Date.now();

  for (const pro of naPros) {
    if (Date.now() - startTime > SCAN_TIMEOUT) {
      console.log('Scan timeout reached, stopping.');
      break;
    }

    try {
      // Parse player_accounts to get gameName + tagline
      let gameName = null;
      let tagline = null;

      if (typeof pro.player_accounts === 'string') {
        // Might be "Name#TAG" format
        const parts = pro.player_accounts.split('#');
        if (parts.length === 2) {
          gameName = parts[0].trim();
          tagline = parts[1].trim();
        }
      } else if (Array.isArray(pro.player_accounts) && pro.player_accounts.length > 0) {
        const acc = pro.player_accounts[0];
        gameName = acc.gameName || acc.name || pro.name;
        tagline = acc.tagLine || acc.tag || '';
      } else if (typeof pro.player_accounts === 'object' && pro.player_accounts !== null) {
        gameName = pro.player_accounts.gameName || pro.player_accounts.name || pro.name;
        tagline = pro.player_accounts.tagLine || pro.player_accounts.tag || '';
      }

      if (!gameName || !tagline) continue;

      const puuid = await getPuuid(gameName, tagline);
      if (!puuid) continue;

      await sleep(200); // reduced from 500ms

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
          team: pro.team_name || '',
          side: side,
          champ: names[proInGame.championId] || '???'
        });
        console.log(`Found pro: ${pro.name} [${pro.team_name}] on ${side} team (${names[proInGame.championId]})`);
      }

    } catch (e) { /* ignore */ }
  }

  currentGame.scanning = false;
  currentGame.scanDone = true;
  console.log(`Scan done. Found ${currentGame.pros.length} pro players.`);
}

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
    return res.send('Invalid format');
  }

  currentGame.pros = [];
  currentGame.scanDone = false;
  scanForGame();

  res.send(`Champions set: ${currentGame.myChamp} | ${currentGame.allies.join(', ')} vs ${currentGame.enemies.join(', ')} - Scanning...`);
});

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
        team: proInfo ? proInfo.team_name : '',
        side: 'unknown'
      });
    }
  }
  currentGame.pros = pros;
  currentGame.scanDone = true;
  res.send('Pro players set: ' + pros.map(p => `${p.name} (${p.champ})`).join(', '));
});

app.get('/clear', async (req, res) => {
  currentGame = { myChamp: '', allies: [], enemies: [], pros: [], scanning: false, scanDone: false };
  res.send('Game cleared');
});

app.get('/pro', async (req, res) => {
  if (currentGame.myChamp) {
    let result = `TF Blade: ${currentGame.myChamp}`;
    if (currentGame.allies.length > 0) result += ` | Team: ${currentGame.allies.join(', ')}`;
    if (currentGame.enemies.length > 0) result += ` | Enemies: ${currentGame.enemies.join(', ')}`;

    if (currentGame.scanning) {
      result += ' | Scanning...';
    } else if (currentGame.pros.length > 0) {
      const allies = currentGame.pros.filter(p => p.side === 'our_team');
      const enemies = currentGame.pros.filter(p => p.side === 'enemy_team');
      const unknown = currentGame.pros.filter(p => p.side === 'unknown');
      if (allies.length > 0) result += ` | PRO Allies: ${allies.map(p => `${p.name} [${p.team}] (${p.champ})`).join(', ')}`;
      if (enemies.length > 0) result += ` | PRO Enemies: ${enemies.map(p => `${p.name} [${p.team}] (${p.champ})`).join(', ')}`;
      if (unknown.length > 0) result += ` | PRO: ${unknown.map(p => `${p.name} [${p.team}] (${p.champ})`).join(', ')}`;
    } else if (currentGame.scanDone) {
      result += ' | No pro players found';
    } else {
      result += ' | Waiting...';
    }
    return res.send(result);
  }

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
    if (!specRes.ok) return res.send('Error: ' + specRes.status);

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
        const entry = { name: pro.name, team: pro.team_name, champ: names[p.championId] || '???' };
        if (p.teamId === myTeam) allies.push(entry);
        else enemies.push(entry);
      }
    }
    let result = `TF Blade: ${names[me.championId] || '???'}`;
    if (allies.length > 0) result += ` | PRO Allies: ${allies.map(a => `${a.name} [${a.team}] (${a.champ})`).join(', ')}`;
    if (enemies.length > 0) result += ` | PRO Enemies: ${enemies.map(e => `${e.name} [${e.team}] (${e.champ})`).join(', ')}`;
    if (allies.length === 0 && enemies.length === 0) result += ' | No pro players in game';
    return res.send(result);
  } catch (e) {
    return res.send('Error: ' + e.message);
  }
});

fetchProList();
app.listen(3000, () => console.log('Running'));   
