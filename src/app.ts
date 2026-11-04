import fs from 'fs';
import { createServer, IncomingMessage } from 'http';
import readyClient from './discord';
import 'dotenv/config';

import express, { NextFunction, Request, Response } from 'express';
import { EAuthTokenPlatformType, LoginSession } from 'steam-session';
import QRCode from 'qrcode'
import { v4 as uuidv4 } from 'uuid';
import WebSocket, { WebSocketServer } from 'ws';
import SGDB from 'steamgriddb';

// import { loggedIn as discordLoggedIn } from "./discord";
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
    // discord: discordLoggedIn,
    discord: false,
    steam: steamAccessToken !== null,
  }
  res.status(200).json(status);
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
    const users = new Map<string, { id: string, username: string, avatar: string | null }>();

    for (const oauthGuild of guilds.values()) {
      const guild = await oauthGuild.fetch(); // Fetch full guild object
      const members = await guild.members.fetch(); // Fetch all members in the guild
      members.forEach(member => {
        if (!users.has(member.id) && !member.user.bot) { // Avoid duplicates and bots
          users.set(member.id, {
            id: member.id,
            username: member.user.username,
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

const activityCache = new Map<string, lobbyActivity>();
function monitorWSHandler(_ms: monitorSession, ws: WebSocket) {
  const wsSend = (type: string, msg: string) => {
    ws.send(JSON.stringify({ type, msg }));
  }
  wsSend("msg", "Monitoring friends list");
  const update = () => {
    fetchSteamFriends()
    .then(friends => steamFriendsToPals(friends))
    .then(({ pals, activities }) => {
      activities.forEach(a => activityCache.set(`${a.type}:${a.id}`, a));
      wsSend("activities", JSON.stringify(activities));
      wsSend("pals", JSON.stringify(pals));
    })
    .catch(err => {
      console.error(err);
      wsSend("err", "Error fetching friends list");
    });
  }
  update();
  const intervalID = setInterval(update, 30000);
  
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

async function fetchSteamFriends() {
  const nicknamesPromise = fetchSteamNicknames();
  const friendIDs = await fetch("https://api.steampowered.com/ISteamUserOAuth/GetFriendList/v1/?access_token=" + steamAccessToken).then(res => res.json()).then(data => data.friends.filter((f: any) => f.relationship === "friend").map((f: any) => f.steamid));
  const friendProfiles = await Promise.all(chunks(friendIDs, 30)
    .map(async (chunk) => {
      const profileData = await fetch("https://api.steampowered.com/ISteamUserOAuth/GetUserSummaries/v1/?access_token=" + steamAccessToken + "&steamids=" + chunk.join(",")).then(res => res.json()).then(data => data.players);
      return profileData;
    })
  );
  const nicknames = await nicknamesPromise;
  return friendProfiles.flat().map((f: SteamFriendProfile) => ({ ...f, nickname: nicknames.get(f.steamid) }));
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
async function fetchSteamGridDBImage(appId: string): Promise<string | null> {
  try {
    const gridData = await client.getGrids({ type: 'steam', id: parseInt(appId), dimensions: ['1024x1024', '512x512'] });
    if (gridData === null || gridData.length === 0) {
      return null;
    }
    const gridImages = gridData.map((img) => img.url);
    return gridImages[0].toString();
  } catch (error) {
    console.error('Error fetching from SteamGridDB:', error);
    return null;
  }
}


async function steamFriendsToPals(friends: SteamFriendProfile[]): Promise<{ pals: lobbyPal[], activities: lobbyActivity[] }> {
  const pals = friends.map(f => {
    return {
      id: `steam:${f.steamid}`,
      name: f.nickname || f.personaname,
      avatarURL: "https://avatars.fastly.steamstatic.com/" + f.avatarhash + "_medium.jpg",
      status: steamStatusToPalStatus(f.personastate),
      activity: f.gameid !== undefined ? `steam:${f.gameid}` : undefined,
    }
  });
  const gameIDs = new Set(friends.filter(f => f.gameid !== undefined).map(f =>
    f.gameid!));
  // Fetch both store data and SteamGridDB images
  const gameData = await Promise.all(Array.from(gameIDs).map(async (gameID) => {
    const [storeData, gridImage] = await Promise.all([
      fetch("https://store.steampowered.com/api/appdetails?appids=" + gameID).then(res => res.json()),
      fetchSteamGridDBImage(gameID)
    ]);
    return { storeData, gridImage };
  }));

  const activities = gameData
    .map(({ storeData, gridImage }) => {
      const appid = Object.keys(storeData)[0];
      if (storeData === null || storeData[appid].success === false) {
        return null;
      }
      const appData = storeData[appid].data;
      return {
        type: "steam" as const,
        id: appid,
        name: appData.name as string,
        backgroundURL: gridImage || appData.header_image as string,
      }
    })
    .filter((a: any) => a !== null) as lobbyActivity[];
  return { pals, activities };
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
}

export default server;
