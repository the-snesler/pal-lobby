// Edits the lobby's pal list (config.json's userMapping) and saves it to the backend.
// userMapping: { "<name shown in the lobby>": ["steam:<steamid>", "discord:<userid>"] }

let allDiscordUsers = [];
let allSteamFriends = [];
let userMappings = {};
let selectedDiscordUser = null;
let selectedSteamFriend = null;
/** Name of the pal loaded into the editor, or null when adding a new one. */
let editingName = null;
let dirty = false;

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  $("discord-search").addEventListener("input", renderDiscordList);
  $("steam-search").addEventListener("input", renderSteamList);
  $("add-mapping").addEventListener("click", savePal);
  $("nickname").addEventListener("keydown", (e) => {
    if (e.key === "Enter") savePal();
  });
  $("clear-editor").addEventListener("click", clearEditor);
  $("save").addEventListener("click", saveConfig);
  $("fill-steam").addEventListener("click", fillFromSteam);
  addEventListener("beforeunload", (e) => {
    if (dirty) e.preventDefault();
  });

  loadConfig();
  loadDiscordUsers();
  loadSteamFriends();
});

// --- Data loading ---

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    userMappings = (await response.json()).userMapping ?? {};
    renderAll();
  } catch (error) {
    console.error("Error loading config:", error);
    $("current-mappings").textContent = "Couldn't load the current config.";
  }
}

async function loadDiscordUsers() {
  try {
    const response = await fetch("/api/discord/users");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    allDiscordUsers = (await response.json()).sort((a, b) => discordLabel(a).localeCompare(discordLabel(b)));
    renderAll();
  } catch (error) {
    console.error("Error fetching Discord users:", error);
    $("discord-list").textContent = "Error loading Discord users.";
  }
}

async function loadSteamFriends() {
  try {
    const response = await fetch("/api/steam/friends");
    if (response.status === 401) {
      $("steam-login-status").hidden = false;
      $("steam-list").textContent = "";
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    allSteamFriends = (await response.json()).sort((a, b) => steamLabel(a).localeCompare(steamLabel(b)));
    renderAll();
  } catch (error) {
    console.error("Error fetching Steam friends:", error);
    $("steam-list").textContent = "Error loading Steam friends.";
  }
}

// --- Helpers ---

const steamKey = (friend) => `steam:${friend.id}`;
const discordKey = (user) => `discord:${user.id}`;
/** What you've named them on Steam, falling back to their own name. */
const steamName = (friend) => friend.nickname || friend.username;
const steamLabel = (friend) => (friend.nickname ? `${friend.nickname} (${friend.username})` : friend.username);
const discordName = (user) => user.displayName || user.username;
const discordLabel = (user) =>
  user.displayName && user.displayName !== user.username ? `${user.displayName} (@${user.username})` : user.username;

/** The pal an account ("steam:..." / "discord:...") belongs to, if any. */
function palFor(accountID) {
  return Object.keys(userMappings).find((name) => userMappings[name].includes(accountID)) ?? null;
}

function accountInfo(accountID) {
  if (accountID.startsWith("steam:")) {
    const friend = allSteamFriends.find((f) => steamKey(f) === accountID);
    return { label: friend ? `Steam: ${steamLabel(friend)}` : `Steam: ${accountID.slice(6)}`, avatar: friend?.avatar };
  }
  const user = allDiscordUsers.find((u) => discordKey(u) === accountID);
  return { label: user ? `Discord: ${discordLabel(user)}` : `Discord: ${accountID.slice(8)}`, avatar: user?.avatar };
}

function matches(label, search) {
  return label.toLowerCase().includes(search.trim().toLowerCase());
}

// --- Name matching (suggests the other half of a pal) ---

/** The names an account goes by, normalized for comparison. */
function nameVariants(...names) {
  const normalized = names.filter(Boolean).map((n) => n.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""));
  return [...new Set(normalized.filter((n) => n.length >= 2))];
}
const steamNames = (friend) => nameVariants(friend.nickname, friend.username);
const discordNames = (user) => nameVariants(user.displayName, user.username);

/** Dice coefficient over character pairs: 1 for identical, 0 for nothing in common. */
function pairSimilarity(a, b) {
  const pairs = new Map();
  for (let i = 0; i < a.length - 1; i++) pairs.set(a.slice(i, i + 2), (pairs.get(a.slice(i, i + 2)) ?? 0) + 1);
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const count = pairs.get(b.slice(i, i + 2));
    if (count) {
      shared++;
      pairs.set(b.slice(i, i + 2), count - 1);
    }
  }
  return (2 * shared) / (a.length + b.length - 2);
}

function nameSimilarity(a, b) {
  if (a === b) return 1;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // "gab" in "gabriel", "cinder" in "cinderquills"
  if (short.length >= 3 && long.includes(short)) return 0.7 + (0.2 * short.length) / long.length;
  return pairSimilarity(a, b);
}

/** Names to match against: the account picked on the other side, plus the pal being edited. */
function matchTargets(otherSideNames) {
  return [...new Set([...(otherSideNames ?? []), ...(editingName ? nameVariants(editingName) : [])])];
}

const suggestionThreshold = 0.6;
const maxSuggestions = 5;

/**
 * Moves the accounts whose names best match `targetNames` (the account selected on the
 * other side) to the top. Returns the reordered items and the keys of the suggestions.
 */
function suggestMatches(items, key, names, targetNames) {
  if (!targetNames?.length) return { items, suggested: new Set() };
  const scored = items
    .map((item) => {
      let score = Math.max(0, ...names(item).flatMap((n) => targetNames.map((t) => nameSimilarity(n, t))));
      // Accounts already in another pal are less likely to be the one you want.
      const pal = palFor(key(item));
      if (pal && pal !== editingName) score *= 0.8;
      return { item, score };
    })
    .filter(({ score }) => score >= suggestionThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSuggestions)
    .map(({ item }) => item);
  const suggested = new Set(scored.map(key));
  return { items: [...scored, ...items.filter((item) => !suggested.has(key(item)))], suggested };
}

function setDirty(value) {
  dirty = value;
  const status = $("save-status");
  status.textContent = dirty ? "Unsaved changes" : "";
  status.className = dirty ? "unsaved" : "";
}

// --- Rendering ---

function renderAll() {
  renderSteamList();
  renderDiscordList();
  renderEditor();
  renderCurrentMappings();
  $("output-json").value = JSON.stringify({ userMapping: userMappings }, null, 2);
}

function renderSteamList() {
  const search = $("steam-search").value;
  const { items, suggested } = suggestMatches(
    allSteamFriends.filter((f) => matches(steamLabel(f), search)),
    steamKey,
    steamNames,
    matchTargets(selectedDiscordUser && discordNames(selectedDiscordUser)),
  );
  renderList(items, $("steam-list"), "steam-item", {
    key: steamKey,
    label: steamLabel,
    selected: selectedSteamFriend,
    suggested,
    onClick: selectSteamFriend,
  });
}

function renderDiscordList() {
  const search = $("discord-search").value;
  const { items, suggested } = suggestMatches(
    allDiscordUsers.filter((u) => matches(discordLabel(u), search)),
    discordKey,
    discordNames,
    matchTargets(selectedSteamFriend && steamNames(selectedSteamFriend)),
  );
  renderList(items, $("discord-list"), "discord-item", {
    key: discordKey,
    label: discordLabel,
    selected: selectedDiscordUser,
    suggested,
    onClick: selectDiscordUser,
  });
}

function renderList(items, listElement, itemClass, { key, label, selected, suggested, onClick }) {
  listElement.replaceChildren(
    ...items.map((item) => {
      const itemDiv = document.createElement("div");
      itemDiv.className = `${itemClass} list-item`;
      if (selected && key(selected) === key(item)) itemDiv.classList.add("selected");
      if (suggested.has(key(item))) itemDiv.classList.add("suggested");
      itemDiv.addEventListener("click", () => onClick(item));

      const img = document.createElement("img");
      img.src = item.avatar || "";
      img.alt = "";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = label(item);
      itemDiv.append(img, nameSpan);

      const pal = palFor(key(item));
      if (pal) {
        const tag = document.createElement("span");
        tag.className = "pal-tag";
        tag.textContent = pal;
        itemDiv.append(tag);
      }
      return itemDiv;
    }),
  );
}

function renderEditor() {
  $("editor-title").textContent = editingName ? `Edit ${editingName}` : "Add a pal";
  $("add-mapping").textContent = editingName ? "Update Pal" : "Add Pal";
  $("selected-steam").textContent = `Selected: ${selectedSteamFriend ? steamLabel(selectedSteamFriend) : "None"}`;
  $("selected-discord").textContent = `Selected: ${selectedDiscordUser ? discordLabel(selectedDiscordUser) : "None"}`;
}

function renderCurrentMappings() {
  const names = Object.keys(userMappings);
  $("pal-count").textContent = names.length;
  const container = $("current-mappings");
  if (names.length === 0) {
    container.textContent = "No pals yet. Pick accounts above, or fill the list from your Steam friends.";
    return;
  }
  const ul = document.createElement("ul");
  for (const name of names) {
    const accounts = userMappings[name].map(accountInfo);
    const li = document.createElement("li");
    if (name === editingName) li.classList.add("editing");

    const img = document.createElement("img");
    img.src = accounts.find((a) => a.avatar)?.avatar ?? "";
    img.alt = "";
    const text = document.createElement("div");
    text.className = "pal-text";
    const strong = document.createElement("strong");
    strong.textContent = name;
    const small = document.createElement("small");
    small.textContent = accounts.map((a) => a.label).join(" · ");
    text.append(strong, small);

    const edit = document.createElement("button");
    edit.textContent = "Edit";
    edit.className = "secondary";
    edit.addEventListener("click", () => editPal(name));
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.className = "danger";
    remove.addEventListener("click", () => removePal(name));

    li.append(img, text, edit, remove);
    ul.append(li);
  }
  container.replaceChildren(ul);
}

// --- Editing ---

function selectSteamFriend(friend) {
  selectedSteamFriend = selectedSteamFriend?.id === friend.id ? null : friend;
  $("discord-list-container").scrollTop = 0;
  afterSelect(selectedSteamFriend && steamKey(friend), selectedSteamFriend && steamName(friend));
}

function selectDiscordUser(user) {
  selectedDiscordUser = selectedDiscordUser?.id === user.id ? null : user;
  $("steam-list-container").scrollTop = 0;
  afterSelect(selectedDiscordUser && discordKey(user), selectedDiscordUser && discordName(user));
}

/** Picking an account that's already a pal opens that pal; otherwise suggest a name. */
function afterSelect(accountID, defaultName) {
  if (accountID && !editingName) {
    const pal = palFor(accountID);
    if (pal) return editPal(pal);
    if (!$("nickname").value.trim()) $("nickname").value = defaultName;
  }
  renderAll();
}

function editPal(name) {
  editingName = name;
  const ids = userMappings[name];
  selectedSteamFriend = allSteamFriends.find((f) => ids.includes(steamKey(f))) ?? null;
  selectedDiscordUser = allDiscordUsers.find((u) => ids.includes(discordKey(u))) ?? null;
  $("nickname").value = name;
  $("steam-list-container").scrollTop = 0;
  $("discord-list-container").scrollTop = 0;
  renderAll();
  $("editor-title").scrollIntoView({ behavior: "smooth" });
}

function clearEditor() {
  editingName = null;
  selectedSteamFriend = null;
  selectedDiscordUser = null;
  $("nickname").value = "";
  $("steam-search").value = "";
  $("discord-search").value = "";
  renderAll();
}

function savePal() {
  const name = $("nickname").value.trim();
  if (!name) return alert("Please enter a name.");
  if (!selectedSteamFriend && !selectedDiscordUser) return alert("Please select a Steam friend and/or a Discord user.");
  if (name !== editingName && name in userMappings) return alert(`There's already a pal named "${name}".`);

  // Keep the edited pal's spot in the list (handles renames too).
  const ids = [selectedSteamFriend && steamKey(selectedSteamFriend), selectedDiscordUser && discordKey(selectedDiscordUser)].filter(Boolean);
  const moved = ids.map((id) => [id, palFor(id)]).filter(([, pal]) => pal && pal !== editingName);
  if (moved.length && !confirm(moved.map(([id, pal]) => `${accountInfo(id).label} is linked to ${pal}.`).join("\n") + "\nMove it to this pal?")) return;

  const next = {};
  let placed = false;
  for (const [existing, existingIDs] of Object.entries(userMappings)) {
    if (existing === editingName) {
      next[name] = ids;
      placed = true;
      continue;
    }
    // An account can only belong to one pal.
    const rest = existingIDs.filter((id) => !ids.includes(id));
    if (rest.length) next[existing] = rest;
  }
  if (!placed) next[name] = ids;
  userMappings = next;
  setDirty(true);
  clearEditor();
}

function removePal(name) {
  delete userMappings[name];
  if (editingName === name) clearEditor();
  setDirty(true);
  renderAll();
}

/** Replace the list with one pal per Steam friend, named as you've named them on Steam. */
function fillFromSteam() {
  if (allSteamFriends.length === 0) return alert("Steam friends haven't loaded (is Steam logged in?).");
  const count = Object.keys(userMappings).length;
  const keepNote = "Discord accounts already linked to those friends stay linked.";
  if (count && !confirm(`Replace your ${count} pals with your ${allSteamFriends.length} Steam friends?\n${keepNote}`)) return;

  const next = {};
  for (const friend of allSteamFriends) {
    let name = steamName(friend).trim() || friend.id;
    for (let n = 2; name in next; n++) name = `${steamName(friend).trim()} ${n}`;
    const existing = palFor(steamKey(friend));
    const discord = existing && userMappings[existing].find((id) => id.startsWith("discord:"));
    next[name] = discord ? [steamKey(friend), discord] : [steamKey(friend)];
  }
  userMappings = next;
  setDirty(true);
  clearEditor();
}

async function saveConfig() {
  const status = $("save-status");
  status.textContent = "Saving...";
  status.className = "";
  try {
    const response = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userMapping: userMappings }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    userMappings = body.userMapping;
    setDirty(false);
    status.textContent = "Saved. The lobby updates right away.";
    status.className = "saved";
    renderAll();
  } catch (error) {
    console.error("Error saving config:", error);
    status.textContent = `Couldn't save: ${error.message}`;
    status.className = "error";
  }
}
