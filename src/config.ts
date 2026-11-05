// The lobby only tracks pals listed in config.json:
//   { "userMapping": { "<display name>": ["steam:<steamid64>", "discord:<userid>"] } }
// Each entry has at most one Steam and one Discord account, and an account belongs to one entry.
import fs from 'fs';

export interface LobbyConfig {
  userMapping: Record<string, string[]>;
}

const configPath = 'config.json';
const idPattern = /^(steam:\d{17}|discord:\d{15,21})$/;
const maxEntries = 1000;
const maxNameLength = 64;

/** Returns the config in normalized form, or an error message. */
export function validateConfig(value: unknown): LobbyConfig | string {
  if (typeof value !== 'object' || value === null) return 'Config must be an object';
  const mapping = (value as { userMapping?: unknown }).userMapping;
  if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) {
    return 'Config needs a "userMapping" object';
  }
  const entries = Object.entries(mapping);
  if (entries.length > maxEntries) return `At most ${maxEntries} pals are allowed`;

  const userMapping: Record<string, string[]> = {};
  const owner = new Map<string, string>();
  for (const [rawName, ids] of entries) {
    const name = rawName.trim();
    if (!name || name.length > maxNameLength) return `Names must be 1-${maxNameLength} characters: "${rawName}"`;
    if (name in userMapping) return `Duplicate name "${name}"`;
    if (!Array.isArray(ids) || ids.length === 0) return `"${name}" needs at least one account`;
    for (const id of ids) {
      if (typeof id !== 'string' || !idPattern.test(id)) return `"${name}" has an invalid account id: ${JSON.stringify(id)}`;
      if (owner.has(id)) return `${id} is linked to both "${owner.get(id)}" and "${name}"`;
      owner.set(id, name);
    }
    for (const type of ['steam', 'discord']) {
      if (ids.filter((id: string) => id.startsWith(type + ':')).length > 1) return `"${name}" has more than one ${type} account`;
    }
    userMapping[name] = ids;
  }
  return { userMapping };
}

export function loadConfig(): LobbyConfig {
  if (!fs.existsSync(configPath)) return { userMapping: {} };
  try {
    const result = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    if (typeof result === 'string') throw new Error(result);
    return result;
  } catch (error) {
    console.error(`Ignoring invalid ${configPath}:`, error);
    return { userMapping: {} };
  }
}

export function saveConfig(config: LobbyConfig) {
  // Write to a temp file and rename, so a crash can't leave half a config behind.
  const temp = `${configPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(temp, configPath);
}

/** One tracked pal, split out of the config. */
export interface ConfiguredPal {
  name: string;
  steamID?: string;
  discordID?: string;
}

export function configuredPals(config: LobbyConfig): ConfiguredPal[] {
  return Object.entries(config.userMapping).map(([name, ids]) => ({
    name,
    steamID: ids.find(id => id.startsWith('steam:'))?.slice('steam:'.length),
    discordID: ids.find(id => id.startsWith('discord:'))?.slice('discord:'.length),
  }));
}
