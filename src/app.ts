import fs from 'fs';
import { createServer, IncomingMessage } from 'http';
import readyClient, { DiscordGame, fetchAppIconURL, getPresences, loggedIn as discordLoggedIn } from './discord';
import { configuredPals, loadConfig, saveConfig, validateConfig } from './config';
import 'dotenv/config';

import express, { NextFunction, Request, Response } from 'express';
import { EAuthTokenPlatformType, LoginSession } from 'steam-session';
import QRCode from 'qrcode'
import { v4 as uuidv4 } from 'uuid';
import WebSocket, { WebSocketServer } from 'ws';
import SGDB from 'steamgriddb';

// import { initializeSteam, loggedIn as steamLoggedIn } from "./steam";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

interface wsSession {
  socket: WebSocket | null;
}
interface steamLoginSession extends wsSession {
  type: "steamLogin";
  loginSession: LoginSession;
}
interface monitorSession extends wsSession {
  type: "monitor";
}

let steamRefreshToken: string | null = null;
let steamAccessToken: string | null = null;
if (fs.existsSync('refreshToken.txt')) {
  steamRefreshToken = fs.readFileSync('refreshToken.txt').toString().trim();
  const steamSession = new LoginSession(EAuthTokenPlatformType.MobileApp);
  steamSession.refreshToken = steamRefreshToken;
  steamSession.refreshAccessToken().then(() => {
    steamAccessToken = steamSession.accessToken;
  });
}

const sessions = new Map<string, steamLoginSession | monitorSession>();
const loggingMiddleware = (req: Request, _: any, next: NextFunction) => {
  const time = new Date(Date.now()).toLocaleString();
  // eslint-disable-next-line no-console
  console.log(`[${time}] ${req.method} ${req.hostname} ${req.path}`);
  next();
}
app.use(loggingMiddleware);
app.use(express.static('public'))
app.get("/api/status", function (_, res) {
  const status = {
    backend: true,
    discord: discordLoggedIn,
    steam: steamAccessToken !== null,
  }
  res.status(200).json(status);
});

let config = loadConfig();
app.get('/api/config', (_, res) => {
  res.json(config);
});
app.put('/api/config', express.json({ limit: '512kb' }), (req, res) => {
  const result = validateConfig(req.body);
  if (typeof result === 'string') {
    return res.status(400).json({ error: result });
  }
  try {
    saveConfig(result);
  } catch (error) {
    console.error("Error saving config:", error);
    return res.status(500).json({ error: "Failed to save config" });
  }
  config = result;
  monitors.forEach(refresh => refresh());
  res.json(config);
});

// Malformed JSON bodies get a short JSON error instead of Express's HTML stack trace.
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: "Invalid JSON" });
  next(err);
});

app.get('/api/steamLogin', async (_, res) => {
  const sessionId = uuidv4();
  const steamSession = new LoginSession(EAuthTokenPlatformType.MobileApp);
  steamSession.loginTimeout = 2 * 60 * 1000; // 2 mins
  const startResult = await steamSession.startWithQR();

  const qrData = QRCode.toDataURL(startResult.qrChallengeUrl as string);
  sessions.set(sessionId, { type: "steamLogin", socket: null, loginSession: steamSession });
  res.json({ qrData: await qrData, sessionId });
});

app.get('/api/monitor', (_, res) => {
  const sessionId = uuidv4();
  sessions.set(sessionId, { type: "monitor", socket: null });
  res.json({ sessionId });
});

app.get('/api/discord/users', async (_, res) => {
  try {
    const client = await readyClient;
    const guilds = await client.guilds.fetch(); // Fetch all guilds the bot is in
    const users = new Map<string, { id: string, username: string, displayName: string, avatar: string | null }>();

    for (const oauthGuild of guilds.values()) {
      const guild = await oauthGuild.fetch(); // Fetch full guild object
      const members = await guild.members.fetch(); // Fetch all members in the guild
      members.forEach(member => {
        if (!users.has(member.id) && !member.user.bot) { // Avoid duplicates and bots
          users.set(member.id, {
            id: member.id,
            username: member.user.username,
            displayName: member.user.globalName ?? member.user.username,
            avatar: member.user.displayAvatarURL(),
          });
        }
      });
    }

    res.json(Array.from(users.values()));
  } catch (error) {
    console.error("Error fetching Discord users:", error);
    res.status(500).json({ error: "Failed to fetch Discord users" });
  }
});

app.get('/api/steam/friends', async (_: Request, res: Response) => {
  if (!steamAccessToken) {
    return res.status(401).json({ error: "Steam not logged in" });
  }
  try {
    const friends = await fetchSteamFriends();
    // Simplify the data sent to the client
    const friendData = friends.map(f => ({
      id: f.steamid,
      username: f.personaname,
      nickname: f.nickname, // what you've named them on Steam, if anything
      avatar: f.avatarmedium, // Use medium avatar
    }));
    res.json(friendData);
  } catch (error) {
    console.error("Error fetching Steam friends:", error);
    res.status(500).json({ error: "Failed to fetch Steam friends" });
  }
});

wss.on('connection', function (ws, req: IncomingMessage) {
  // url = /ws/:sessionId
  if (!req.url?.startsWith('/ws/')) {
    ws.close();
    return;
  }
  const url = req.url?.split('/');
  if (url === undefined) {
    ws.close();
    return;
  }
  const sessionId = url[2];
  if (!sessions.has(sessionId)) {
    ws.close();
    return;
  }
  const session = sessions.get(sessionId)!;
  session.socket = ws;

  ws.on('error', (err) => {
    console.error(err);
  });
  ws.on('close', () => {
    sessions.delete(sessionId);
  });

  switch (session.type) {
    case "steamLogin":
      steamLoginWSHandler(session, ws);
      break;
    case "monitor":
      monitorWSHandler(session, ws);
      break;
  }
});

function steamLoginWSHandler(ss: steamLoginSession, ws: WebSocket) {
  const wsSend = (type: string, msg: string) => {
    ws.send(JSON.stringify({ type, msg }));
  }
  const ls = ss.loginSession;
  ls.on('remoteInteraction', () => {
    wsSend("msg", "Approve login on your phone");
  });
  ls.on('authenticated', async () => {
    steamRefreshToken = ls.refreshToken;
    fs.writeFileSync('refreshToken.txt', ls.refreshToken);
    wsSend("success", "Authenticated successfully! SteamID = " + ls.steamID);
    ws.close();
    ls.cancelLoginAttempt();
    ls.refreshAccessToken().then(() => {
      steamAccessToken = ls.accessToken;
    });
  });
  ls.on('timeout', () => {
    wsSend("err", "Login attempt timed out");
  });
  ls.on('error', (err: any) => {
    wsSend("err", err.message);
  });
}

/** Refresh functions of open lobby sockets, run when the config changes. */
const monitors = new Set<() => void>();
function monitorWSHandler(_ms: monitorSession, ws: WebSocket) {
  const wsSend = (type: string, msg: string) => {
    ws.send(JSON.stringify({ type, msg }));
  }
  wsSend("msg", "Monitoring pals");
  // Updates can overlap (timer + config change); only send the newest.
  let latest = 0;
  const update = () => {
    const run = ++latest;
    buildLobby()
    .then(({ pals, activities }) => {
      if (run !== latest || ws.readyState !== WebSocket.OPEN) return;
      if (pals.length === 0) wsSend("msg", "No pals configured yet: add some on the Map Friends page");
      wsSend("activities", JSON.stringify(activities));
      wsSend("pals", JSON.stringify(pals));
    })
    .catch(err => {
      console.error(err);
      if (ws.readyState === WebSocket.OPEN) wsSend("err", "Error fetching pals");
    });
  }
  update();
  const intervalID = setInterval(update, 30000);
  monitors.add(update);
  
  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.type === "activity") {
      const activity = activityCache.get(data.id);
      if (activity === undefined) {
        wsSend("err", "Activity not found");
        return;
      }
      wsSend("activities", JSON.stringify([activity]));
    }
  });

  ws.on('close', () => {
    clearInterval(intervalID);
    monitors.delete(update);
  });
}
function chunks<T>(array: T[], chunkSize: number): T[][] {
  const result = [];

  for (let i = 0; i < array.length; i += chunkSize) {
    const chunk = array.slice(i, i + chunkSize);
    result.push(chunk);
  }

  return result;
}

/** Nicknames you've set for friends, keyed by 64-bit SteamID. Best-effort: empty on failure. */
async function fetchSteamNicknames(): Promise<Map<string, string>> {
  try {
    const data = await fetch("https://api.steampowered.com/IPlayerService/GetNicknameList/v1/?access_token=" + steamAccessToken).then(res => res.json());
    const list: { accountid: number, nickname: string }[] = data?.response?.nicknames ?? [];
    // The list uses 32-bit account IDs; convert to the 64-bit individual-account SteamID.
    return new Map(list.map(n => [(BigInt("76561197960265728") + BigInt(n.accountid)).toString(), n.nickname]));
  } catch (error) {
    console.error("Error fetching Steam nicknames:", error);
    return new Map();
  }
}

async function fetchSteamProfiles(steamIDs: string[]): Promise<SteamFriendProfile[]> {
  const profiles = await Promise.all(chunks(steamIDs, 100).map(async (chunk) => {
    const res = await fetch("https://api.steampowered.com/ISteamUserOAuth/GetUserSummaries/v1/?access_token=" + steamAccessToken + "&steamids=" + chunk.join(","));
    if (!res.ok) throw new Error(`GetUserSummaries failed: HTTP ${res.status}`);
    return (await res.json()).players as SteamFriendProfile[];
  }));
  return profiles.flat();
}

/** Your Steam friends, with the nicknames you've given them. Used to build the config. */
async function fetchSteamFriends() {
  const nicknamesPromise = fetchSteamNicknames();
  const friendIDs = await fetch("https://api.steampowered.com/ISteamUserOAuth/GetFriendList/v1/?access_token=" + steamAccessToken).then(res => res.json()).then(data => data.friends.filter((f: any) => f.relationship === "friend").map((f: any) => f.steamid));
  const profiles = await fetchSteamProfiles(friendIDs);
  const nicknames = await nicknamesPromise;
  return profiles.map(f => ({ ...f, nickname: nicknames.get(f.steamid) }));
}

function steamStatusToPalStatus(steamStatus: number): 0 | 1 | 2 {
  switch (steamStatus) {
    case 0: return 0;
    case 1: return 2;
    case 4: return 1;
  }
  return 0;
}

const client = new SGDB(process.env.STEAMGRIDDB_API_KEY || "");
const gridDimensions = ['1024x1024', '512x512'];

interface GameArt {
  /** Square cover, used for group circles. */
  grid: string | null;
  /** Small square icon, used for solo badges. */
  icon: string | null;
}

/** Grid and icon from SteamGridDB, by Steam app id ("steam") or SteamGridDB game id ("game"). */
async function fetchSteamGridDBArt(type: 'steam' | 'game', id: number): Promise<GameArt> {
  const [grids, icons] = await Promise.all([
    client.getGrids({ type, id, dimensions: gridDimensions }),
    client.getIcons({ type, id, mimes: ['image/png'] }),
  ].map(request => request.catch((error) => {
    console.error(`Error fetching SteamGridDB art for ${type} ${id}:`, error);
    return [];
  })));
  // Prefer the game's own icon over fan-made ones.
  // (The API returns style as a string, though the typings say string[].)
  const icon = icons.find(i => [i.style].flat().includes('official')) ?? icons[0];
  return { grid: grids[0]?.url.toString() ?? null, icon: icon?.url.toString() ?? null };
}

/** The small icon Steam shows next to a game in the friends list (32x32). */
async function fetchSteamCommunityIcon(appID: string): Promise<string | null> {
  const input = {
    ids: [{ appid: Number(appID) }],
    context: { language: "english", country_code: "US" },
    data_request: { include_assets: true },
  };
  try {
    const res = await fetch("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=" + encodeURIComponent(JSON.stringify(input)));
    if (!res.ok) return null;
    const hash = (await res.json())?.response?.store_items?.[0]?.assets?.community_icon;
    return hash ? `https://cdn.fastly.steamstatic.com/steamcommunity/public/images/apps/${appID}/${hash}.jpg` : null;
  } catch (error) {
    console.error(`Error fetching Steam icon for ${appID}:`, error);
    return null;
  }
}

/** For matching game names across Steam, Discord and SteamGridDB. */
function normalizeGameName(name: string) {
  return name.toLowerCase().replace(/[™®©]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** SteamGridDB art for a game that isn't on Steam, matched by exact name. */
async function fetchSteamGridDBArtByName(name: string): Promise<GameArt> {
  try {
    const game = (await client.searchGame(name)).find(g => normalizeGameName(g.name) === normalizeGameName(name));
    if (game) return await fetchSteamGridDBArt('game', game.id);
  } catch (error) {
    console.error('Error searching SteamGridDB:', error);
  }
  return { grid: null, icon: null };
}

/** The Steam app with exactly this name, if there is one. */
async function findSteamApp(name: string): Promise<string | null> {
  const res = await fetch("https://store.steampowered.com/api/storesearch/?l=english&cc=US&term=" + encodeURIComponent(name));
  if (!res.ok) return null;
  const items: { id: number, name: string }[] = (await res.json()).items ?? [];
  const match = items.find(item => normalizeGameName(item.name) === normalizeGameName(name));
  return match ? String(match.id) : null;
}

/** Activities sent to clients, keyed "type:id". */
const activityCache = new Map<string, lobbyActivity>();
/** In-flight and finished lookups, so each game is only looked up once. */
const activityLookups = new Map<string, Promise<lobbyActivity | null>>();
const failedLookupRetry = 10 * 60 * 1000;

function lookupActivity(key: string, lookup: () => Promise<lobbyActivity | null>) {
  let result = activityLookups.get(key);
  if (!result) {
    result = lookup()
      .catch((error) => {
        console.error(`Error looking up activity ${key}:`, error);
        return null;
      })
      .then((activity) => {
        if (activity) activityCache.set(`${activity.type}:${activity.id}`, activity);
        else setTimeout(() => activityLookups.delete(key), failedLookupRetry);
        return activity;
      });
    activityLookups.set(key, result);
  }
  return result;
}

function steamActivity(appID: string) {
  return lookupActivity(`steam:${appID}`, async () => {
    const [storeData, art, steamIcon] = await Promise.all([
      fetch("https://store.steampowered.com/api/appdetails?appids=" + appID).then(res => res.json()),
      fetchSteamGridDBArt('steam', parseInt(appID)),
      fetchSteamCommunityIcon(appID),
    ]);
    // Non-Steam shortcuts and delisted apps have no store page.
    const app = storeData?.[appID];
    if (!app?.success) return null;
    return {
      type: "steam" as const,
      id: appID,
      name: app.data.name,
      backgroundURL: art.grid || app.data.header_image,
      // Steam's own icon matches what the friends list shows.
      iconURL: steamIcon ?? art.icon ?? undefined,
    };
  });
}

/** A game seen in Discord presence. Uses the Steam game of the same name when there is one, so Steam and Discord players share a circle. */
function discordActivity(game: DiscordGame) {
  const id = game.applicationID ?? `name:${normalizeGameName(game.name)}`;
  return lookupActivity(`discord:${id}`, async () => {
    const steamAppID = await findSteamApp(game.name);
    const fromSteam = steamAppID && await steamActivity(steamAppID);
    if (fromSteam) return fromSteam;
    const [art, appIcon] = await Promise.all([
      fetchSteamGridDBArtByName(game.name),
      game.applicationID ? fetchAppIconURL(game.applicationID) : null,
    ]);
    return {
      type: "discord" as const,
      id,
      name: game.name,
      backgroundURL: art.grid ?? appIcon ?? game.imageURL ?? "",
      iconURL: appIcon ?? art.icon ?? undefined,
    };
  });
}

/** The pals in the config, with Steam as the main source and Discord filling in status and games. */
async function buildLobby(): Promise<{ pals: lobbyPal[], activities: lobbyActivity[] }> {
  const entries = configuredPals(config);
  const steamIDs = entries.flatMap(e => e.steamID ? [e.steamID] : []);
  const discordIDs = entries.flatMap(e => e.discordID ? [e.discordID] : []);
  const [profiles, presences] = await Promise.all([
    steamAccessToken && steamIDs.length ? fetchSteamProfiles(steamIDs) : [],
    getPresences(discordIDs),
  ]);
  const profileByID = new Map(profiles.map(p => [p.steamid, p]));

  const activities = new Map<string, lobbyActivity>();
  const pals = await Promise.all(entries.map(async (entry): Promise<lobbyPal> => {
    const steam = entry.steamID ? profileByID.get(entry.steamID) : undefined;
    const discord = entry.discordID ? presences.get(entry.discordID) : undefined;
    // Steam's game wins; Discord's is used when Steam shows none (or one we can't look up).
    let activity = steam?.gameid ? await steamActivity(steam.gameid) : null;
    if (!activity && discord?.game) activity = await discordActivity(discord.game);
    const activityKey = activity ? `${activity.type}:${activity.id}` : undefined;
    if (activity) activities.set(activityKey!, activity);
    return {
      id: entry.steamID ? `steam:${entry.steamID}` : `discord:${entry.discordID}`,
      name: entry.name,
      avatarURL: steam
        ? "https://avatars.fastly.steamstatic.com/" + steam.avatarhash + "_medium.jpg"
        : discord?.avatarURL ?? "",
      status: Math.max(steam ? steamStatusToPalStatus(steam.personastate) : 0, discord?.status ?? 0) as 0 | 1 | 2,
      activity: activityKey,
    };
  }));
  return { pals, activities: [...activities.values()] };
}

interface SteamFriendProfile {
  steamid: string;
  communityvisibilitystate: number;
  profilestate: number;
  personaname: string;
  profileurl: string;
  avatar: string; // avatar urls, small, medium, full
  avatarmedium: string;
  avatarfull: string;
  avatarhash: string;
  lastlogoff: number;
  personastate: number; // Online status! 0 = offline, 1 = online, 4 = away
  primaryclanid: string;
  timecreated: number;
  personastateflags: number;
  gameextrainfo?: string; // Only if in game
  gameid?: string;
  nickname?: string; // set by us from GetNicknameList, not part of the summary
}

interface lobbyPal {
  id: string; // steam:steamid, stable across renames
  name: string;
  avatarURL: string;
  status: 0 | 1 | 2; // 0 = offline, 1 = idle, 2 = online
  activity?: string; // steam:id or discord:id
}
interface lobbyActivity {
  type: "steam" | "discord";
  id: string;
  name: string;
  backgroundURL: string;
  iconURL?: string; // for solo badges; clients fall back to backgroundURL
}

export default server;
