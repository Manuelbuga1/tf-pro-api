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

async function fetchProList() {
  try {
    const res = await fetch(PROS_URL, { headers: PROS_HEADERS });
    const data = await res.json();
    const arr = data.data || [];
    const newList = {};
    for (const p of arr) {
      if (p.name) {
        newList[p.name.toLowerCase()] = {
          name: p.name,
          position: p.position || ''
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

app.get('/pro', async (req, res) => {
  try {
    if (Date.now() - proListLastFetch > CACHE_MS) await fetchProList();

    if (!cachedPuuid) {
      const accRes = await fetch(
        `${ACCOUNTS_BASE}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(RIOT_ID)}/${TAG}`,
        { headers: { 'X-Riot-Token': API_KEY } }
      );
      const { puuid } = await accRes.json();
      cachedPuuid = puuid;
    }

    const specRes = await fetch(
      `${BASE}/lol/spectator/v5/active-games/by-puuid/${cachedPuuid}`,
      { headers: { 'X-Riot-Token': API_KEY } }
    );

    if (specRes.status === 404) {
      return res.send('Nu e in meci acum');
    }

    const game = await specRes.json();
    const names = await getChampionNames();
    const me = game.participants.find(p => p.puuid === cachedPuuid);
    if (!me) return res.send('Nu e in meci acum');

    const myTeam = me.teamId;
    const myChamp = names[me.championId] || '???';
    const allies = [];
    const enemies = [];

    for (const p of game.participants) {
      if (p.puuid === cachedPuuid) continue;
      const gameName = p.riotId?.gameName || '';
      const pro = proList[gameName.toLowerCase()];
      if (pro) {
        const entry = {
          name: pro.name,
          position: pro.position,
          champ: names[p.championId] || '???'
        };
        if (p.teamId === myTeam) allies.push(entry);
        else enemies.push(entry);
      }
    }

    let result = `TF Blade: ${myChamp}`;
    if (allies.length > 0) {
      result += ` | Aliați PRO: ${allies.map(a => `${a.name} [${a.position}] (${a.champ})`).join(', ')}`;
    }
    if (enemies.length > 0) {
      result += ` | Inamici PRO: ${enemies.map(e => `${e.name} [${e.position}] (${e.champ})`).join(', ')}`;
    }
    if (allies.length === 0 && enemies.length === 0) {
      result += ' | Fără pro players în meci';
    }

    res.send(result);
  } catch (e) {
    res.send('Eroare la fetch');
  }
});

fetchProList();

app.listen(3000, () => console.log('Running'));   
