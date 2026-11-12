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
  pros: []
};

async function fetchProList() {
  try {
    const res = await fetch(PROS_URL, { headers: PROS_HEADERS });
    const data = await res.json();
    const arr = data.data || [];
    console.log('FIRST PLAYER KEYS:', Object.keys(arr[0]));
    console.log('FIRST PLAYER FULL:', JSON.stringify(arr[0]).substring(0, 500));
    const newList = {};
    for (const p of arr) {
      if (p.name) {
        newList[p.name.toLowerCase()] = {
          name: p.name,
          position: p.position || '',
          tagline: p.tagline || p.tag || p.game_tag || ''
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
  res.send(`Champions set: ${currentGame.myChamp} | ${currentGame.allies.join(', ')} vs ${currentGame.enemies.join(', ')}`);
});

// === SET PROS ===
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
        position: proInfo ? proInfo.position : ''
      });
    }
  }
  currentGame.pros = pros;
  res.send('Pro players set: ' + pros.map(p => `${p.name} (${p.champ})`).join(', '));
});

// === CLEAR ===
app.get('/clear', async (req, res) => {
  currentGame = { myChamp: '', allies: [], enemies: [], pros: [] };
  res.send('Game cleared');
});

// === PRO ===
app.get('/pro', async (req, res) => {
  if (currentGame.myChamp) {
    let result = `TF Blade: ${currentGame.myChamp}`;
    if (currentGame.allies.length > 0) result += ` | Team: ${currentGame.allies.join(', ')}`;
    if (currentGame.enemies.length > 0) result += ` | Enemies: ${currentGame.enemies.join(', ')}`;
    if (currentGame.pros.length > 0) {
      result += ` | PRO: ${currentGame.pros.map(p => `${p.name}${p.position ? ' [' + p.position + ']' : ''} (${p.champ})`).join(', ')}`;
    } else {
      result += ' | No pro players identified';
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
      const accData = await accRes.json();
      cachedPuuid = accData.puuid;
    }

    const specRes = await fetch(
      `${BASE}/lol/spectator/v5/active-games/by-summoner/${cachedPuuid}`,
      { headers: { 'X-Riot-Token': API_KEY } }
    );

    if (specRes.status === 404) return res.send('Not in a game right now');
    if (specRes.status === 429) return res.send('Rate limited, try again in a few seconds');
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
