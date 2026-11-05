import { ActivityType, Client, Events, GatewayIntentBits, Presence, PresenceStatus } from 'discord.js';
import 'dotenv/config';

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildPresences,
] });

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error("Discord login failed:", error);
});

export let loggedIn = false;
const readyClient: Promise<Client<true>> = new Promise((resolve) => {
  client.once(Events.ClientReady, readyClient => {
    console.log(`Discord logged in as ${readyClient.user.tag}`);
    loggedIn = true;
    resolve(readyClient);
  });
});

export default readyClient;

export interface DiscordGame {
  name: string;
  applicationID: string | null;
  /** Rich presence art, which may change with in-game state. */
  imageURL: string | null;
}

export interface DiscordPresence {
  status: 0 | 1 | 2; // same scale as lobby pals
  avatarURL?: string;
  game?: DiscordGame;
}

function palStatus(status: PresenceStatus | undefined): 0 | 1 | 2 {
  switch (status) {
    case "online":
    case "dnd":
      return 2;
    case "idle":
      return 1;
    default:
      return 0;
  }
}

/**
 * Status, avatar and current game for the given users, from the bot's presence cache.
 * Users the bot can't see (or before it's logged in) come back offline.
 */
export async function getPresences(userIDs: string[]): Promise<Map<string, DiscordPresence>> {
  const result = new Map<string, DiscordPresence>();
  if (!loggedIn) return result;
  const ready = await readyClient;
  await Promise.all(userIDs.map(async (id) => {
    let presence: Presence | undefined;
    for (const guild of ready.guilds.cache.values()) {
      presence = guild.presences.cache.get(id);
      if (presence) break;
    }
    const user = ready.users.cache.get(id) ?? await ready.users.fetch(id).catch(() => null);
    const playing = presence?.activities.find(a => a.type === ActivityType.Playing);
    result.set(id, {
      status: palStatus(presence?.status),
      avatarURL: user?.displayAvatarURL({ size: 128 }),
      game: playing && {
        name: playing.name,
        applicationID: playing.applicationId,
        imageURL: playing.assets?.largeImageURL({ size: 512 }) ?? null,
      },
    });
  }));
  return result;
}

/** A Discord application's icon, if it has one (public endpoint, no auth needed). */
export async function fetchAppIconURL(applicationID: string): Promise<string | null> {
  const res = await fetch(`https://discord.com/api/v10/applications/${applicationID}/rpc`);
  if (!res.ok) return null;
  const app = await res.json();
  return app.icon ? `https://cdn.discordapp.com/app-icons/${applicationID}/${app.icon}.png?size=512` : null;
}
