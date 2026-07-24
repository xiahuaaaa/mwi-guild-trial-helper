// ==UserScript==
// @name         MWI 公会试炼资料同步助手
// @namespace    https://greasyfork.org/users/1466859-adudu
// @version      0.4.1
// @description  TMD 公会专用：自动同步成员名单、全部配装、技能与光环。
// @author       adudu
// @license      MIT
// @homepageURL  https://github.com/xiahuaaaa/mwi-guild-trial-helper
// @supportURL   https://github.com/xiahuaaaa/mwi-guild-trial-helper/issues
// @downloadURL  https://raw.githubusercontent.com/xiahuaaaa/mwi-guild-trial-helper/main/dist/mwi-guild-trial-sync.user.js
// @updateURL    https://raw.githubusercontent.com/xiahuaaaa/mwi-guild-trial-helper/main/dist/mwi-guild-trial-sync.user.js
// @match        https://*.milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @connect      adudu.tailab136f.ts.net
// @run-at       document-start
// ==/UserScript==

/*
 * Independent MIT-licensed implementation by adudu.
 *
 * Data boundary:
 * - reads only the character, guild roster, equipment, loadout and ability
 *   records required by the TMD guild tools;
 * - checks the detected character against the TMD roster before automatic sync;
 * - never includes cookies, login/session credentials or authorization data in
 *   the snapshot.
 */
(function aduduGuildTrialSync() {
  "use strict";
  const MAX_COMBAT_CANDIDATES = 4;
  const FIXED_GUILD_ID = "TMD";
  const DEFAULT_API_BASE = "https://adudu.tailab136f.ts.net";
  const PAGE_BRIDGE_CHANNEL = "adudu-mwi-guild-snapshot-v1";
  const UI_COLLAPSED_KEY = "uiCollapsed";
  const UI_POSITION_KEY = "uiCollapsedPosition";
  const UI = Object.freeze({
    root: "adudu-guild-sync",
    list: "adudu-guild-sync-loadouts",
    status: "adudu-guild-sync-status",
    bridge: "adudu-guild-sync-bridge",
  });
  const HYDRATION_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 12000];
  const state = {
    character: {},
    guild: {},
    guildCharacterMap: {},
    guildSharableCharacterMap: {},
    loadouts: [],
    authorizedEquipment: [],
    skills: [],
    learnedAbilities: [],
    auras: [],
  };
  const hydration = { attempt: 0, timer: 0, characterId: "" };
  const automaticSync = { timer: 0, running: false, lastSignature: "" };

  const values = (value) => Array.isArray(value) ? value : value instanceof Map ? [...value.values()] : value instanceof Set ? [...value.values()] : value && typeof value === "object" ? Object.values(value) : [];
  const entries = (value) => value instanceof Map ? [...value.entries()] : value && typeof value === "object" ? Object.entries(value) : [];
  const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const parseJson = (value) => {
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
    } catch { return null; }
  };
  const auraEntries = (entries) => values(entries)
    .filter((ability) => String(ability?.abilityHrid ?? ability?.hrid ?? "").endsWith("_aura"));
  const hasCharacterData = () => Object.keys(state.character).length > 0 || state.loadouts.length > 0 || state.skills.length > 0;
  const mergeAuthorizedEquipment = (...collections) => {
    const highest = new Map();
    for (const raw of collections.flatMap(values)) {
      if (!raw || typeof raw !== "object") continue;
      const itemHrid = String(raw.itemHrid ?? raw.item_hrid ?? raw.hrid ?? "");
      if (!itemHrid) continue;
      const enhancementLevel = Number(raw.enhancementLevel ?? raw.enhancement_level ?? 0);
      const previous = highest.get(itemHrid);
      if (!previous || enhancementLevel > previous.enhancementLevel) {
        highest.set(itemHrid, { ...raw, itemHrid, enhancementLevel });
      }
    }
    return [...highest.values()];
  };
  const loadoutEquipmentPool = () => state.loadouts.flatMap((loadout) =>
    values(loadout?.equipment ?? loadout?.items ?? loadout?.loadoutItems)
  );

  function applyCharacterData(candidate) {
    const data = object(candidate);
    const characterInfo = object(data.characterInfo);
    const character = data.character ?? characterInfo.character;
    if (character && typeof character === "object") state.character = character;
    const guild = data.guild ?? characterInfo.guild;
    if (guild && typeof guild === "object") state.guild = { ...state.guild, ...guild };
    const guildName = data.guildName ?? character?.guildName ?? characterInfo.character?.guildName;
    if (typeof guildName === "string" && guildName.trim()) state.guild.name = guildName.trim();
    const guildCharacterMap = data.guildCharacterMap ?? data.guildCharacterDict;
    if (guildCharacterMap && typeof guildCharacterMap === "object") state.guildCharacterMap = guildCharacterMap;
    const guildSharableCharacterMap = data.guildSharableCharacterMap ?? data.guildSharableCharacterDict;
    if (guildSharableCharacterMap && typeof guildSharableCharacterMap === "object") state.guildSharableCharacterMap = guildSharableCharacterMap;
    const equipment = data.equipment ?? data.inventory ?? data.characterItems ?? data.characterItemMap
      ?? characterInfo.characterItems ?? characterInfo.characterItemMap;
    if (equipment) state.authorizedEquipment = mergeAuthorizedEquipment(state.authorizedEquipment, equipment);
    const skills = data.characterSkills ?? data.skills ?? characterInfo.characterSkills;
    if (skills) state.skills = values(skills);
    const learned = data.characterAbilities ?? data.learnedAbilities ?? data.characterAbilityMap
      ?? characterInfo.characterAbilities ?? characterInfo.characterAbilityMap;
    if (learned) {
      state.learnedAbilities = values(learned);
      state.auras = auraEntries(state.learnedAbilities);
    }
    const loadouts = data.loadouts ?? data.combatLoadouts ?? data.characterLoadoutMap
      ?? data.characterLoadoutDict ?? data.characterLoadouts ?? characterInfo.characterLoadoutMap;
    if (loadouts) state.loadouts = values(loadouts);
  }

  /**
   * Modern MWI keeps the initial character payload in these exact same-origin
   * cache keys. This is a fallback for userscripts installed after the initial
   * WebSocket message; it reads no general storage or authentication data.
   */
  function hydrateFromGameCache() {
    const init = parseJson(localStorage.getItem("init_character_data"));
    if (init) applyCharacterData(init.data ?? init.payload ?? init);
    // Current MWI clients store the initial event stream under initClientData.
    // It can be plain JSON or LZString-compressed JSON, depending on client
    // version.  This stays entirely same-origin and read-only.
    const initClientRaw = localStorage.getItem("initClientData");
    if (initClientRaw) {
      const page = typeof unsafeWindow === "object" ? unsafeWindow : window;
      const lz = page.LZString ?? window.LZString;
      const initClient = parseJson(initClientRaw)
        ?? parseJson(lz?.decompressFromUTF16?.(initClientRaw))
        ?? parseJson(lz?.decompressFromBase64?.(initClientRaw));
      if (initClient) applyCharacterData(initClient.data ?? initClient.payload ?? initClient);
    }
    const skills = parseJson(localStorage.getItem("characterSkills"));
    if (skills && !state.skills.length) state.skills = values(skills);
    refresh();
    return Boolean(init && hasCharacterData()) || hasCharacterData();
  }

  // The current character and saved loadouts are held in the game's top-level
  // React state.  Reading this in-memory state is needed because it is not
  // included in initClientData on all client versions.  We neither invoke game
  // methods nor mutate its state.
  function hydrateFromLiveGame() {
    try {
      const page = typeof unsafeWindow === "object" ? unsafeWindow : window;
      const documents = [...new Set([document, page.document].filter(Boolean))];
      const roots = documents.flatMap((doc) => [doc.querySelector('[class^="GamePage"]'), doc.getElementById("root")].filter(Boolean));
      const queue = roots.flatMap((root) => {
        const key = Object.keys(root).find((name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$") || name.startsWith("__react"));
        return key ? [root[key]] : [];
      });
      const seen = new Set();
      while (queue.length) {
        const fiber = queue.shift();
        if (!fiber || typeof fiber !== "object" || seen.has(fiber)) continue;
        seen.add(fiber);
        const candidate = fiber.stateNode?.state;
        if (candidate && typeof candidate === "object" && (candidate.characterLoadoutDict || candidate.characterLoadoutMap || candidate.characterLabyrinth || candidate.combatUnit || candidate.gameConn || candidate.guildCharacterMap || candidate.guildSharableCharacterMap || candidate.guild)) {
          applyCharacterTree(candidate);
          refresh();
          return hasCharacterData();
        }
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
    } catch { /* unavailable during initial render */ }
    return false;
  }

  // State nesting differs across MWI client releases.  Search only the already
  // located in-memory game-state tree, with strict depth/node limits, and pull
  // only objects that expose character or loadout fields.
  function applyCharacterTree(root) {
    const queue = [{ value: root, depth: 0 }];
    const seen = new Set();
    let visited = 0;
    while (queue.length && visited < 3000) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value); visited += 1;
      if (value.character || value.characterInfo || value.characterLoadoutDict || value.characterLoadoutMap || value.characterItems || value.characterSkills || value.guildCharacterMap || value.guildSharableCharacterMap || value.guild) applyCharacterData(value);
      if (depth >= 5) continue;
      for (const key of Object.keys(value)) {
        if (/token|authorization|cookie|secret|password|credential|session/i.test(key)) continue;
        try {
          const child = value[key];
          if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
        } catch { /* skip inaccessible reactive field */ }
      }
    }
  }

  // The published .user.js is deliberately standalone. The same contract is
  // exercised in Node through member-snapshot-payload-builder.js; this small
  // browser copy avoids a remote @require or any network dependency.
  const localBuilder = {
    buildMemberSnapshot(input) {
      const safe = (value) => Array.isArray(value) ? value.map(safe) : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).filter(([key]) => !/(token|authorization|cookie|secret|password|credential|session|gm_)/i.test(key)).map(([key, child]) => [key, safe(child)])) : value;
      const list = (value) => Array.isArray(value) ? value : [];
      const string = (value) => typeof value === "string" ? value.trim() : (Number.isFinite(value) ? String(value) : "");
      const count = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : fallback;
      const levels = (value) => {
        const result = {};
        const rows = Array.isArray(value) ? value : Object.entries(value && typeof value === "object" ? value : {}).map(([hrid, raw]) => ({ hrid, ...(raw && typeof raw === "object" ? raw : { level: raw }) }));
        for (const row of rows) {
          const hrid = string(row.hrid ?? row.skillHrid ?? row.skill_hrid ?? row.abilityHrid ?? row.ability_hrid);
          if (hrid.startsWith("/")) result[hrid] = Math.max(result[hrid] ?? 0, count(row.level));
        }
        return result;
      };
      const isConsumable = (value) => /food|drink|consumable|potion/i.test(value);
      const equipment = (items) => {
        const byLocation = new Map();
        for (const item of list(items)) {
          const locationHrid = string(item.locationHrid ?? item.itemLocationHrid ?? item.location_hrid ?? item.slot);
          const itemHrid = string(item.itemHrid ?? item.item_hrid ?? item.hrid);
          if (locationHrid && itemHrid && !isConsumable(`${locationHrid} ${itemHrid}`)) {
            byLocation.set(locationHrid, { locationHrid, itemHrid, enhancementLevel: count(item.enhancementLevel ?? item.enhancement_level) });
          }
        }
        return [...byLocation.values()].sort((left, right) => left.locationHrid.localeCompare(right.locationHrid)).slice(0, 20);
      };
      const abilities = (items) => list(items).slice(0, 5).flatMap((item, slot) => {
        const abilityHrid = string(item.abilityHrid ?? item.ability_hrid ?? item.hrid);
        if (!abilityHrid || isConsumable(abilityHrid)) return [];
        const triggers = list(item.triggers ?? item.combatTriggers ?? item.combat_triggers).flatMap((trigger) => {
          const dependencyHrid = string(trigger.dependencyHrid ?? trigger.combatTriggerDependencyHrid ?? trigger.dependency_hrid);
          const conditionHrid = string(trigger.conditionHrid ?? trigger.combatTriggerConditionHrid ?? trigger.condition_hrid);
          const comparatorHrid = string(trigger.comparatorHrid ?? trigger.combatTriggerComparatorHrid ?? trigger.comparator_hrid);
          const value = Number(trigger.value ?? 0);
          return dependencyHrid && conditionHrid && comparatorHrid && Number.isFinite(value) && !isConsumable(`${dependencyHrid} ${conditionHrid} ${comparatorHrid}`) ? [{ dependencyHrid, conditionHrid, comparatorHrid, value }] : [];
        });
        return [{ slot: count(item.slot, slot), abilityHrid, level: Math.max(1, count(item.level, 1)), triggers }];
      });
      const character = input.character && typeof input.character === "object" ? input.character : {};
      const allowed = new Map();
      for (const raw of list(input.authorizedEquipment ?? character.equipment ?? character.inventory)) {
        const row = raw && typeof raw === "object" ? raw : {};
        const itemHrid = string(row.itemHrid ?? row.item_hrid ?? row.hrid);
        if (!itemHrid || isConsumable(itemHrid)) continue;
        const level = count(row.enhancementLevel ?? row.enhancement_level);
        const levelsForItem = allowed.get(itemHrid) ?? [];
        if (!levelsForItem.includes(level)) levelsForItem.push(level);
        allowed.set(itemHrid, levelsForItem);
      }
      for (const levelsForItem of allowed.values()) levelsForItem.sort((a, b) => a - b);
      const resolveOwnedEquipment = (items) => {
        let missing = false;
        const resolvedEquipment = items.map((item) => {
          const levelsForItem = allowed.get(item.itemHrid) ?? [];
          const level = levelsForItem.at(-1);
          if (level == null) {
            missing = true;
            return item;
          }
          return { ...item, enhancementLevel: level };
        });
        return { equipment: resolvedEquipment, missing };
      };
      const requested = [...new Set(list(input.selectedLoadoutIds).map(string).filter(Boolean))].slice(0, MAX_COMBAT_CANDIDATES);
      const capturedAt = new Date(input.capturedAt ?? Date.now()).toISOString();
      const approvedBuilds = list(input.loadouts).filter((loadout) => requested.includes(string(loadout.loadoutId ?? loadout.loadout_id ?? loadout.id ?? loadout.buildId))).map((loadout, index) => {
        const resolved = resolveOwnedEquipment(equipment(loadout.equipment ?? loadout.items ?? loadout.loadoutItems));
        const slots = abilities(loadout.abilities ?? loadout.combatAbilities ?? loadout.combat_abilities);
        if (!resolved.equipment.length || !slots.length || resolved.missing) return null;
        const sourceLoadoutId = loadout.loadoutId ?? loadout.loadout_id ?? loadout.id;
        return { buildId: string(loadout.buildId) || `loadout:${string(sourceLoadoutId) || index + 1}`, ...(sourceLoadoutId == null ? {} : { sourceLoadoutId: count(sourceLoadoutId) }), name: string(loadout.name) || `Combat loadout ${index + 1}`, approvedByMember: true, capturedAt, equipment: resolved.equipment, abilities: slots, simulationReady: true, issues: [] };
      }).filter(Boolean);
      const loadoutCatalog = list(input.loadouts).slice(0, 64).map((loadout, index) => {
        const actionTypeHrid = string(loadout.actionTypeHrid ?? loadout.action_type_hrid) || "/action_types/all";
        const category = actionTypeHrid === "/action_types/combat" ? "combat" : actionTypeHrid === "/action_types/all" ? "all" : actionTypeHrid.startsWith("/action_types/") ? "profession" : "unknown";
        const resolved = resolveOwnedEquipment(equipment(loadout.equipment ?? loadout.items ?? loadout.loadoutItems));
        const slots = abilities(loadout.abilities ?? loadout.combatAbilities ?? loadout.combat_abilities);
        const sourceLoadoutId = loadout.loadoutId ?? loadout.loadout_id ?? loadout.id;
        return {
          ...(sourceLoadoutId == null ? {} : { sourceLoadoutId: count(sourceLoadoutId) }),
          name: string(loadout.name) || `Loadout ${index + 1}`,
          category,
          actionTypeHrid,
          equipment: resolved.equipment,
          abilities: slots,
          issues: resolved.missing ? ["contains-equipment-not-found-in-current-inventory"] : [],
        };
      });
      const memberId = string(input.memberId ?? character.memberId ?? character.characterId ?? character.id) || "unknown-member";
      return safe({ schemaVersion: "2", memberId, displayName: string(input.displayName ?? character.displayName ?? character.name) || memberId, guildId: string(input.guildId ?? character.guildId), capturedAt, source: "manual", sourceSchemaVersion: "mwi-local-exporter-v1", freshness: "fresh", confidence: approvedBuilds.length ? "simulation-ready" : "capability-only", skills: levels(input.skills ?? character.skills), learnedAbilities: levels(input.learnedAbilities ?? character.learnedAbilities), auras: levels(input.auras ?? character.auras), loadoutCatalog, approvedBuilds, participation: { eligibleBossHrids: [], preferredBossHrids: [], maxBossAssignments: 1, allowRoleChange: true, allowSkillChange: true }, issues: approvedBuilds.length === requested.length ? [] : ["some-selected-loadouts-were-incomplete-or-not-owned"] });
    },
  };

  function recordPacket(packet) {
    if (!packet || typeof packet !== "object") return;
    const type = String(packet.type ?? packet.event ?? packet.action ?? "");
    const data = packet.data ?? packet.payload ?? packet;
    if (type === "init_character_data") applyCharacterData(data);
    if (type === "loadouts_updated") {
      const updated = data.loadouts ?? data.combatLoadouts ?? data.characterLoadoutMap ?? data.characterLoadoutDict ?? data;
      state.loadouts = values(updated);
    }
    applyCharacterData(data);
    refresh();
  }

  function pageBridgeMain(channel) {
    const values = (value) => Array.isArray(value) ? value : value instanceof Map ? [...value.values()] : value && typeof value === "object" ? Object.values(value) : [];
    const entries = (value) => value instanceof Map ? [...value.entries()] : value && typeof value === "object" ? Object.entries(value) : [];
    const dictionary = (value) => value instanceof Map ? Object.fromEntries(value) : value && typeof value === "object" ? value : {};
    const compact = (gameState) => {
      const character = gameState?.character || gameState?.currentCharacter || gameState?.playerCharacter || {};
      const id = character?.id ?? character?.characterId ?? gameState?.characterId;
      const name = character?.name ?? character?.characterName ?? gameState?.characterName;
      if (!id || !name) return null;
      const characterItems = values(gameState?.characterItems || gameState?.characterItemMap || gameState?.characterItemDict).slice(0, 5000);
      const itemByHash = new Map();
      for (const [key, item] of entries(gameState?.characterItemMap || gameState?.characterItems || gameState?.characterItemDict)) {
        itemByHash.set(String(key), item);
        if (item?.hash) itemByHash.set(String(item.hash), item);
      }
      const abilityLevelByHrid = new Map(entries(gameState?.characterAbilityMap || gameState?.characterAbilities || gameState?.characterAbilityDict)
        .map(([key, ability]) => [String(ability?.abilityHrid || ability?.hrid || key), Number(ability?.level || 1)]));
      const loadouts = values(gameState?.characterLoadoutDict || gameState?.characterLoadoutMap).map((loadout) => {
        const equipment = entries(loadout?.wearableMap || loadout?.equipment || loadout?.items).flatMap(([locationHrid, reference]) => {
          if (!reference) return [];
          const item = typeof reference === "object" ? reference : itemByHash.get(String(reference));
          const parts = String(reference).split("::");
          const itemHrid = item?.itemHrid || parts.find((part) => part.startsWith("/items/")) || "";
          const enhancementLevel = Number(item?.enhancementLevel ?? parts.at(-1) ?? 0);
          return itemHrid ? [{ locationHrid: String(locationHrid), itemHrid, enhancementLevel }] : [];
        });
        const triggerMap = loadout?.abilityCombatTriggersMap || {};
        const abilities = entries(loadout?.abilityMap || loadout?.abilities || loadout?.combatAbilities).flatMap(([slot, abilityHrid]) => {
          if (!abilityHrid) return [];
          const hrid = String(abilityHrid);
          return [{
            slot: Math.max(0, Number(slot) - 1),
            abilityHrid: hrid,
            level: abilityLevelByHrid.get(hrid) || 1,
            triggers: values(triggerMap instanceof Map ? triggerMap.get(hrid) : triggerMap[hrid]),
          }];
        });
        return {
          loadoutId: loadout?.id ?? loadout?.loadoutId,
          name: loadout?.name,
          actionTypeHrid: loadout?.actionTypeHrid,
          equipment,
          abilities,
        };
      });
      return {
        character: {
          id,
          name,
          guildId: character?.guildId ?? character?.guildID ?? gameState?.guildId,
          guildName: character?.guildName ?? gameState?.guildName ?? gameState?.guild?.name,
        },
        guild: gameState?.guild,
        guildName: character?.guildName ?? gameState?.guildName ?? gameState?.guild?.name,
        guildCharacterMap: dictionary(gameState?.guildCharacterMap || gameState?.guildCharacterDict),
        guildSharableCharacterMap: dictionary(gameState?.guildSharableCharacterMap || gameState?.guildSharableCharacterDict),
        characterSkills: values(gameState?.characterSkills || gameState?.characterSkillMap || gameState?.characterSkillDict),
        characterItems: [
          ...characterItems,
          ...loadouts.flatMap((loadout) => loadout.equipment),
        ],
        characterAbilities: values(gameState?.characterAbilities || gameState?.characterAbilityMap || gameState?.characterAbilityDict),
        combatAbilities: values(gameState?.combatAbilities || gameState?.combatUnit?.combatAbilities),
        loadouts,
      };
    };
    const recover = () => {
      const roots = [document.querySelector('[class^="GamePage_gamePage"]'), document.getElementById("root"), document.body].filter(Boolean);
      const queue = roots.flatMap((root) => Reflect.ownKeys(root).filter((key) => String(key).startsWith("__reactFiber$") || String(key).startsWith("__reactContainer$")).map((key) => root[key]));
      const seen = new Set(); let best = null; let score = -1;
      for (let index = 0; index < queue.length && index < 8000; index += 1) {
        const fiber = queue[index];
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const result = compact(fiber.stateNode?.state);
        if (result) {
          const next = result.loadouts.length * 10000
            + Object.keys(result.guildCharacterMap).length * 100
            + result.characterItems.length
            + result.characterSkills.length;
          if (next > score) { best = result; score = next; }
        }
        if (fiber.return) queue.push(fiber.return);
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      if (best) window.postMessage({ source: channel, type: "state", payload: best }, window.location.origin);
    };
    window.addEventListener("message", (event) => { if (event.origin === window.location.origin && event.data?.source === channel && event.data?.type === "request") recover(); });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", recover, { once: true }); else recover();
  }

  function installPageBridge() {
    window.addEventListener("message", (event) => {
      if (event.origin !== location.origin || event.data?.source !== PAGE_BRIDGE_CHANNEL || event.data?.type !== "state") return;
      applyCharacterData(event.data.payload);
      refresh();
      if (hasCharacterData()) {
        clearTimeout(hydration.timer);
        hydration.timer = 0;
        setStatus("已读取游戏角色数据。");
      }
    });
    if (!document.documentElement || document.getElementById(UI.bridge)) return;
    const script = document.createElement("script");
    script.id = UI.bridge;
    script.textContent = `;(${pageBridgeMain.toString()})(${JSON.stringify(PAGE_BRIDGE_CHANNEL)});`;
    document.documentElement.append(script); script.remove();
  }

  function currentCharacterId() {
    return new URLSearchParams(location.search).get("characterId") || "";
  }

  function resetCharacterData() {
    state.character = {};
    state.guild = {};
    state.guildCharacterMap = {};
    state.guildSharableCharacterMap = {};
    state.loadouts = [];
    state.authorizedEquipment = [];
    state.skills = [];
    state.learnedAbilities = [];
    state.auras = [];
    refresh();
  }

  function requestCharacterData({ reset = false } = {}) {
    clearTimeout(hydration.timer);
    hydration.timer = 0;
    const characterId = currentCharacterId();
    if (reset || characterId !== hydration.characterId) {
      hydration.characterId = characterId;
      hydration.attempt = 0;
      resetCharacterData();
    }
    if (hydrateFromGameCache() || hydrateFromLiveGame()) {
      hydration.attempt = 0;
      setStatus("已读取游戏角色数据。");
      return;
    }
    setStatus(`等待游戏角色数据加载…（${hydration.attempt + 1}/${HYDRATION_RETRY_DELAYS_MS.length + 1}）`, true);
    window.postMessage({ source: PAGE_BRIDGE_CHANNEL, type: "request" }, location.origin);
    if (hydration.attempt >= HYDRATION_RETRY_DELAYS_MS.length) return;
    const delay = HYDRATION_RETRY_DELAYS_MS[hydration.attempt];
    hydration.attempt += 1;
    hydration.timer = setTimeout(() => requestCharacterData(), delay);
  }

  // Narrow page bridge: only observes two documented game events. It neither
  // sends messages nor reads localStorage/cookies/tokens. React state can call
  // window.postMessage({ source: PAGE_BRIDGE_CHANNEL, packet }, location.origin).
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data?.source !== PAGE_BRIDGE_CHANNEL) return;
    recordPacket(event.data.packet);
  });
  const dispatch = WebSocket.prototype.dispatchEvent;
  WebSocket.prototype.dispatchEvent = function patchedDispatch(event) {
    if (event?.type === "message" && typeof event.data === "string") {
      try { recordPacket(JSON.parse(event.data)); } catch { /* non-JSON game frames are irrelevant */ }
    }
    return dispatch.call(this, event);
  };

  function builder() {
    return window.MwiTrialPayloadBuilder ?? localBuilder;
  }
  function detectedMemberId() {
    return String(state.character.name ?? state.character.characterName ?? state.character.displayName ?? "").trim();
  }
  function detectedGameGuild() {
    const id = Number(state.guild.id ?? state.guild.guildId ?? state.character.guildId ?? state.character.guildID);
    const name = String(state.guild.name ?? state.guild.guildName ?? state.character.guildName ?? "").trim();
    return { id: Number.isInteger(id) && id > 0 ? id : null, name };
  }
  function confirmedTmdGuild() {
    const guild = detectedGameGuild();
    const characterGuildId = Number(state.character.guildId ?? state.character.guildID);
    return guild.name === FIXED_GUILD_ID
      && guild.id != null
      && (!Number.isInteger(characterGuildId) || characterGuildId === guild.id);
  }
  function guildRosterPayload() {
    if (!confirmedTmdGuild()) return null;
    const guild = detectedGameGuild();
    const sharable = state.guildSharableCharacterMap;
    const members = entries(state.guildCharacterMap).flatMap(([mapKey, guildCharacter]) => {
      const playerId = Number(guildCharacter?.characterID ?? guildCharacter?.characterId ?? mapKey);
      if (!Number.isInteger(playerId) || playerId <= 0) return [];
      const shared = sharable instanceof Map
        ? sharable.get(mapKey) ?? sharable.get(playerId) ?? sharable.get(String(playerId)) ?? {}
        : sharable?.[mapKey] ?? sharable?.[playerId] ?? sharable?.[String(playerId)] ?? {};
      const memberId = String(shared?.name ?? guildCharacter?.name ?? "").trim();
      if (!memberId) return [];
      return [{
        playerId,
        memberId,
        status: String(guildCharacter?.status ?? "ACTIVE").trim() || "ACTIVE",
        guildRole: String(guildCharacter?.role ?? "").trim(),
      }];
    });
    const reporterPlayerId = Number(state.character.id ?? state.character.characterId);
    const reporterMemberId = detectedMemberId();
    if (!members.length || !Number.isInteger(reporterPlayerId) || reporterPlayerId <= 0) return null;
    if (!members.some((member) => member.playerId === reporterPlayerId && member.memberId === reporterMemberId)) return null;
    return {
      guild: { id: guild.id, name: guild.name },
      reporter: { playerId: reporterPlayerId, memberId: reporterMemberId },
      members,
      capturedAt: new Date().toISOString(),
    };
  }
  function payload() {
    hydrateFromGameCache();
    hydrateFromLiveGame();
    const api = builder();
    return api.buildMemberSnapshot({
      character: state.character,
      loadouts: state.loadouts,
      authorizedEquipment: mergeAuthorizedEquipment(
        state.authorizedEquipment,
        loadoutEquipmentPool(),
      ),
      skills: state.skills,
      learnedAbilities: state.learnedAbilities,
      auras: state.auras,
      memberId: detectedMemberId() || undefined,
      displayName: detectedMemberId() || undefined,
      guildId: FIXED_GUILD_ID,
      selectedLoadoutIds: [],
      capturedAt: new Date().toISOString(),
    });
  }
  function download() {
    const snapshot = payload();
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement("a"), { href: url, download: `mwi-member-snapshot-v2-${snapshot.memberId}.json` });
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function setStatus(message, isError = false) {
    const node = document.getElementById(UI.status);
    if (!node) return;
    node.textContent = message;
    node.style.color = isError ? "#ff9d9d" : "#9ff0b2";
  }
  function requestJson({ method, url, data }) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method,
      url,
      headers: { "content-type": "application/json" },
      data: data == null ? undefined : JSON.stringify(data),
      timeout: 15_000,
      onload: resolve,
      ontimeout: () => reject(new Error("同步超时")),
      onerror: () => reject(new Error("无法连接公会资料服务")),
    }));
  }
  async function upload({ automatic = false } = {}) {
    if (automaticSync.running) return;
    const snapshot = payload();
    if (!snapshot.memberId || snapshot.memberId === "unknown-member") {
      setStatus("等待读取游戏角色名。", true);
      return;
    }
    if (!confirmedTmdGuild()) {
      setStatus("尚未从游戏确认当前角色属于 TMD；请打开公会界面后重试。", true);
      return;
    }
    const roster = guildRosterPayload();
    const signature = JSON.stringify({ memberId: snapshot.memberId, loadoutCatalog: snapshot.loadoutCatalog, skills: snapshot.skills, learnedAbilities: snapshot.learnedAbilities, auras: snapshot.auras, roster });
    if (automatic && signature === automaticSync.lastSignature) return;
    automaticSync.running = true;
    try {
      setStatus(`正在检查 ${snapshot.memberId} 的 TMD 成员资格…`);
      const eligibility = await requestJson({
        method: "GET",
        url: `${DEFAULT_API_BASE}/api/public/guilds/${FIXED_GUILD_ID}/members/${encodeURIComponent(snapshot.memberId)}/eligibility`,
      });
      const eligibilityBody = JSON.parse(eligibility.responseText || "{}");
      if (eligibility.status !== 200 || eligibilityBody.eligible !== true) {
        setStatus(`当前角色 ${snapshot.memberId} 不在 TMD 成员名单中，不会上传资料。`, true);
        return;
      }
      let rosterSummary = "";
      if (eligibilityBody.rosterSyncAllowed === true && roster) {
        setStatus(`正在同步 TMD 当前名单（${roster.members.length} 人）…`);
        const rosterResponse = await requestJson({
          method: "POST",
          url: `${DEFAULT_API_BASE}/api/public/guilds/${FIXED_GUILD_ID}/roster`,
          data: roster,
        });
        if (rosterResponse.status >= 200 && rosterResponse.status < 300) {
          rosterSummary = `名单 ${roster.members.length} 人、`;
        } else if (rosterResponse.status !== 429) {
          let rosterDetail = `HTTP ${rosterResponse.status}`;
          try { rosterDetail = JSON.parse(rosterResponse.responseText)?.error?.message ?? rosterDetail; } catch { /* keep status */ }
          rosterSummary = `名单未更新（${rosterDetail}）、`;
        }
      }
      setStatus("正在自动同步全部配装…");
      const response = await requestJson({
        method: "POST",
        url: `${DEFAULT_API_BASE}/api/public/guilds/${FIXED_GUILD_ID}/members/${encodeURIComponent(snapshot.memberId)}/snapshots`,
        data: snapshot,
      });
      if (response.status < 200 || response.status >= 300) {
        let detail = `HTTP ${response.status}`;
        try { detail = JSON.parse(response.responseText)?.error?.message ?? detail; } catch { /* keep status */ }
        throw new Error(detail);
      }
      automaticSync.lastSignature = signature;
      setStatus(`已同步${rosterSummary}${snapshot.loadoutCatalog.length} 套配装（${snapshot.memberId}）。`);
    } catch (error) {
      setStatus(`同步失败：${error.message}`, true);
    } finally {
      automaticSync.running = false;
    }
  }
  function scheduleAutomaticUpload(delay = 800) {
    clearTimeout(automaticSync.timer);
    automaticSync.timer = setTimeout(() => upload({ automatic: true }), delay);
  }
  function refresh() {
    const list = document.getElementById(UI.list);
    if (!list) return;
    const catalog = builder().buildMemberSnapshot({
      character: state.character,
      loadouts: state.loadouts,
      authorizedEquipment: mergeAuthorizedEquipment(
        state.authorizedEquipment,
        loadoutEquipmentPool(),
      ),
      skills: state.skills,
      learnedAbilities: state.learnedAbilities,
      auras: state.auras,
      selectedLoadoutIds: [],
      capturedAt: new Date().toISOString(),
    }).loadoutCatalog ?? [];
    const catalogById = new Map(catalog.map((entry, index) => [
      String(entry.sourceLoadoutId ?? index + 1),
      entry,
    ]));
    list.replaceChildren(...state.loadouts.map((loadout, index) => {
      const id = String(loadout.loadoutId ?? loadout.loadout_id ?? loadout.id ?? index + 1);
      const actionTypeHrid = String(loadout.actionTypeHrid ?? loadout.action_type_hrid ?? "");
      const category = actionTypeHrid === "/action_types/combat"
        ? "战斗"
        : !actionTypeHrid || actionTypeHrid === "/action_types/all"
          ? "所有行动"
          : actionTypeHrid.startsWith("/action_types/")
            ? "生活"
            : "未识别";
      const catalogEntry = catalogById.get(id);
      const simulationReady = category === "战斗"
        && Boolean(catalogEntry?.equipment?.length)
        && Boolean(catalogEntry?.abilities?.length)
        && !catalogEntry?.issues?.length;
      const label = document.createElement("label");
      const suffix = category === "战斗" && !simulationReady ? "（缺少当前拥有的装备或技能）" : "";
      label.append(` [${category}] ${loadout.name ?? `Loadout ${index + 1}`}${suffix}`);
      return label;
    }));
    if (hasCharacterData()) scheduleAutomaticUpload();
  }
  function actionButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  function mount() {
    if (document.getElementById(UI.root)) return;
    const panel = document.createElement("aside");
    panel.id = UI.root;
    panel.setAttribute("aria-label", "MWI 公会试炼资料同步");
    panel.style.cssText = [
      "position:fixed", "right:14px", "bottom:14px", "z-index:2147483647",
      "width:min(290px,calc(100vw - 28px))", "padding:12px",
      "background:linear-gradient(145deg,#151d34,#202d50)", "color:#f7f9ff",
      "border:1px solid #7f96dd", "border-radius:10px",
      "box-shadow:0 10px 28px #05091688", "font:13px/1.4 system-ui,sans-serif",
    ].join(";");

    const content = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = "adudu · 公会试炼资料";
    const intro = document.createElement("p");
    intro.style.margin = "6px 0";
    intro.textContent = "TMD 专用；打开公会界面后自动同步当前名单及全部配装，职业通过 QQ 机器人绑定。";
    const list = document.createElement("div");
    list.id = UI.list;
    const status = document.createElement("p");
    status.id = UI.status;
    status.style.cssText = "margin:7px 0;color:#c9d4ff";
    status.textContent = "等待读取角色资料";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:5px;flex-wrap:wrap";
    actions.append(
      actionButton("立即同步", () => upload()),
      actionButton("导出备份", download),
    );
    content.append(heading, intro, list, status, actions);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.style.cssText = "position:absolute;top:7px;right:7px;border:0;background:#344879;color:#fff;border-radius:7px;min-width:26px;height:26px;cursor:pointer;font:700 17px/1 system-ui,sans-serif";
    const clampFrogPosition = (position) => {
      const margin = 8;
      const width = panel.offsetWidth || 48;
      const height = panel.offsetHeight || 48;
      const maximumX = Math.max(margin, window.innerWidth - width - margin);
      const maximumY = Math.max(margin, window.innerHeight - height - margin);
      return {
        x: Math.round(Math.min(Math.max(Number(position?.x) || margin, margin), maximumX)),
        y: Math.round(Math.min(Math.max(Number(position?.y) || margin, margin), maximumY)),
      };
    };
    const placeCollapsedFrog = (savedPosition) => {
      const fallback = {
        x: window.innerWidth - (panel.offsetWidth || 48) - 14,
        y: window.innerHeight - (panel.offsetHeight || 48) - 14,
      };
      const validSavedPosition = Number.isFinite(Number(savedPosition?.x)) && Number.isFinite(Number(savedPosition?.y));
      const position = clampFrogPosition(validSavedPosition ? savedPosition : fallback);
      panel.style.left = `${position.x}px`;
      panel.style.top = `${position.y}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      return position;
    };
    const applyCollapsed = (collapsed) => {
      panel.dataset.collapsed = collapsed ? "true" : "false";
      content.hidden = collapsed;
      toggle.textContent = collapsed ? "🐸" : "−";
      toggle.title = collapsed ? "展开公会资料同步助手" : "缩小公会资料同步助手";
      toggle.setAttribute("aria-label", toggle.title);
      if (collapsed) {
        panel.style.width = "46px";
        panel.style.height = "46px";
        panel.style.padding = "0";
        panel.style.borderRadius = "50%";
        toggle.style.cssText = "position:absolute;inset:0;width:46px;height:46px;border:0;background:transparent;cursor:grab;font:25px/46px system-ui,sans-serif;padding:0;touch-action:none;user-select:none";
        placeCollapsedFrog(GM_getValue(UI_POSITION_KEY, null));
      } else {
        panel.style.left = "auto";
        panel.style.top = "auto";
        panel.style.right = "14px";
        panel.style.bottom = "14px";
        panel.style.width = "min(290px,calc(100vw - 28px))";
        panel.style.height = "auto";
        panel.style.padding = "12px";
        panel.style.borderRadius = "10px";
        toggle.style.cssText = "position:absolute;top:7px;right:7px;border:0;background:#344879;color:#fff;border-radius:7px;min-width:26px;height:26px;cursor:pointer;font:700 17px/1 system-ui,sans-serif";
      }
    };
    let dragState = null;
    let suppressNextClick = false;
    toggle.addEventListener("pointerdown", (event) => {
      if (panel.dataset.collapsed !== "true") return;
      event.preventDefault();
      const position = clampFrogPosition({
        x: Number.parseFloat(panel.style.left),
        y: Number.parseFloat(panel.style.top),
      });
      dragState = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: position.x,
        startY: position.y,
        moved: false,
      };
      toggle.setPointerCapture?.(event.pointerId);
      toggle.style.cursor = "grabbing";
    });
    toggle.addEventListener("pointermove", (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      const deltaX = event.clientX - dragState.startClientX;
      const deltaY = event.clientY - dragState.startClientY;
      if (Math.hypot(deltaX, deltaY) >= 4) dragState.moved = true;
      if (dragState.moved) placeCollapsedFrog({
        x: dragState.startX + deltaX,
        y: dragState.startY + deltaY,
      });
    });
    const finishDrag = (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      if (dragState.moved) {
        const position = placeCollapsedFrog({
          x: Number.parseFloat(panel.style.left),
          y: Number.parseFloat(panel.style.top),
        });
        GM_setValue(UI_POSITION_KEY, position);
        suppressNextClick = true;
      }
      toggle.releasePointerCapture?.(event.pointerId);
      toggle.style.cursor = "grab";
      dragState = null;
    };
    toggle.addEventListener("pointerup", finishDrag);
    toggle.addEventListener("pointercancel", finishDrag);
    toggle.addEventListener("click", () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      const collapsed = panel.dataset.collapsed !== "true";
      GM_setValue(UI_COLLAPSED_KEY, collapsed);
      applyCollapsed(collapsed);
    });
    panel.append(content, toggle);
    document.body.append(panel);
    applyCollapsed(Boolean(GM_getValue(UI_COLLAPSED_KEY, false)));
    window.addEventListener("resize", () => {
      if (panel.dataset.collapsed !== "true") return;
      GM_setValue(UI_POSITION_KEY, placeCollapsedFrog(GM_getValue(UI_POSITION_KEY, null)));
    });
    installPageBridge();
    requestCharacterData({ reset: true });
    setInterval(() => {
      if (currentCharacterId() !== hydration.characterId) requestCharacterData({ reset: true });
    }, 3000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !hasCharacterData()) requestCharacterData();
    });
  }
  document.addEventListener("DOMContentLoaded", mount, { once: true });
  if (document.readyState !== "loading") mount();
})();
