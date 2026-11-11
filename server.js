// server.js
const express = require('express');
const app = express();

const API_KEY = process.env.RIOT_API_KEY;
const RIOT_ID = 'Right Click';
const TAG = '133';
const BASE = 'https://na1.api.riotgames.com';
const ACCOUNTS_BASE = 'https://americas.api.riotgames.com';
const PROS_URL = 'https://www.trackingthepros.com/d/list_players';

// Cache PUUID
let cachedPuuid = null;

// Cache lista de pro players (se reîncarcă la 30 min)
let proList = {};
let proListLastFetch = 0;
const PRO_CACHE_MS = 30 * 60 * 1000;

async function fetchProList() {
  try {
    const res = await fetch(PROS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await res.json();
    const newList = {};
    // data.data e array de obiecte cu { name, team, role, current, ... }
    for (const p of data.data) {
      if (p.name && p.team) {
        newList[p.name.toLowerCase()] = { name: p.name, team: p.team, role: p.role };
      }
    }
    proList = newList;
    proListLastFetch = Date.now();
    console.log(`Pro list updated: ${Object.keys(proList).length} players`);
  } catch (e) {
    console.error('Failed to fetch pro list:', e.message);
    // Păstrăm lista veche dacă eșuează
  }
}

// Cache champion names
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

app.get('/pro', async (req, res) => {
  try {
    // Reîncarcă lista de pro dacă e expirată
    if (Date.now() - proListLastFetch > PRO_CACHE_MS) {
      await fetchProList();
    }

    // 1. PUUID
    if (!cachedPuuid) {
      const accRes = await fetch(
        `${ACCOUNTS_BASE}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(RIOT_ID)}/${TAG}`,
        { headers: { 'X-Riot-Token': API_KEY } }
      );
      const { puuid } = await accRes.json();
      cachedPuuid = puuid;
    }

    // 2. Spectator API
    const specRes = await fetch(
      `${BASE}/lol/spectator/v5/active-games/by-puuid/${cachedPuuid}`,
      { headers: { 'X-Riot-Token': API_KEY } }
    );

    if (specRes.status === 404) {
      return res.send('Nu e în meci acum');
    }

    const game = await specRes.json();
    const names = await getChampionNames();

    // 3. Găsește echipa TF Blade
    const me = game.participants.find(p => p.puuid === cachedPuuid);
    if (!me) return res.send('Nu e în meci acum');

    const myTeam = me.teamId;
    const myChamp = names[me.championId] || '???';

    // 4. Scanează participanții pentru pro players
    const allies = [];
    const enemies = [];

    for (const p of game.participants) {
      if (p.puuid === cachedPuuid) continue;
      const gameName = p.riotId?.gameName || '';
      const pro = proList[gameName.toLowerCase()];
      if (pro) {
        const entry = {
          name: pro.name,
          team: pro.team,
          role: pro.role,
          champ: names[p.championId] || '???'
        };
        if (p.teamId === myTeam) allies.push(entry);
        else enemies.push(entry);
      }
    }

    // 5. Formatează output
    let result = `TF Blade: ${myChamp}`;
    if (allies.length > 0) {
      result += ` | Aliați PRO: ${allies.map(a => `${a.name} [${a.team}] (${a.champ})`).join(', ')}`;
    }
    if (enemies.length > 0) {
      result += ` | Inamici PRO: ${enemies.map(e => `${e.name} [${e.team}] (${e.champ})`).join(', ')}`;
    }
    if (allies.length === 0 && enemies.length === 0) {
      result += ' | Fără pro players în meci';
    }

    res.send(result);
  } catch (e) {
    res.send('Eroare la fetch');
  }
});

// La pornire, încarcă lista de pro
fetchProList();

app.listen(3000, () => console.log('Running'));   
