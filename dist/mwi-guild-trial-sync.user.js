// ==UserScript==
// @name         TMD-guild-trial-sync
// @name:en      TMD-guild-trial-sync
// @namespace    https://greasyfork.org/users/1466859-adudu
// @version      0.6.17
// @description  TMD 公会专用：自动同步成员名单、本周试炼、怪物面板、全部配装、技能与光环，并高亮最新战斗分工。
// @description:en  TMD guild sync: roster, weekly trials, monster panels, loadouts, abilities, auras, and the latest combat assignment.
// @author       adudu
// @license      MIT
// @homepageURL  https://github.com/xiahuaaaa/mwi-guild-trial-helper
// @supportURL   https://github.com/xiahuaaaa/mwi-guild-trial-helper/issues
// @downloadURL  https://update.greasyfork.org/scripts/588902/MWI%20%E5%85%AC%E4%BC%9A%E8%AF%95%E7%82%BC%E8%B5%84%E6%96%99%E5%90%8C%E6%AD%A5%E5%8A%A9%E6%89%8B.user.js
// @updateURL    https://update.greasyfork.org/scripts/588902/MWI%20%E5%85%AC%E4%BC%9A%E8%AF%95%E7%82%BC%E8%B5%84%E6%96%99%E5%90%8C%E6%AD%A5%E5%8A%A9%E6%89%8B.meta.js
// @match        https://*.milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @connect      adudu.tailab136f.ts.net
// @connect      raw.githubusercontent.com
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
  const COMBAT_ASSIGNMENT_JSON_URL = "https://raw.githubusercontent.com/xiahuaaaa/mwi-guild-trial-helper/main/reports/combat-assignment/latest.json";
  const LIFE_ASSIGNMENT_JSON_URL = "https://raw.githubusercontent.com/xiahuaaaa/mwi-guild-trial-helper/main/reports/life-assignment/latest.json";
  const COMBAT_ABILITY_ICON_BASE = "https://mwi-guild.43.167.210.211.sslip.io/dist/icons/abilities";
  const COMBAT_ASSIGNMENT_CACHE_MS = 5 * 60 * 1000;
  const COMBAT_ASSIGNMENT_POLL_MS = 30 * 1000;
  const COMBAT_TRIAL_CARD_SELECTOR = "div[class*=trialTile]";
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
  // Follow game language (i18nextLng). Do not use the browser UI language.
  const zh = Object.freeze({
    ariaLabel: "TMD-guild-trial-sync",
    heading: "adudu · 公会试炼资料",
    intro: "TMD 专用；登录后自动同步本周试炼类型、怪物面板、当前名单、双 Boss 报名及全部配装，职业通过 QQ 机器人绑定。",
    waitingCharacter: "等待读取角色资料",
    syncNow: "立即同步",
    exportBackup: "导出备份",
    expand: "展开公会资料同步助手",
    collapse: "缩小公会资料同步助手",
    categoryCombat: "战斗",
    categoryAll: "所有行动",
    categorySkilling: "生活",
    categoryUnknown: "未识别",
    characterLoaded: "已读取游戏角色数据。",
    waitingHydration: (current, total) => `等待游戏角色数据加载…（${current}/${total}）`,
    syncTimeout: "同步超时",
    syncUnreachable: "无法连接公会资料服务",
    waitingName: "等待读取游戏角色名。",
    notTmdYet: "尚未从游戏确认当前角色属于 TMD；请打开公会界面后重试。",
    notTmdDetail: (detail) => `尚未从游戏确认当前角色属于 TMD（${detail}）。请打开「公会」界面后点「立即同步」。`,
    waitingEquipmentAuto: "已检测到配装名称，正在等待游戏装备数据…",
    waitingEquipmentManual: "检测到配装名称，但尚未从游戏读取装备；请等待游戏加载完成后重试",
    checkingEligibility: (memberId) => `正在检查 ${memberId} 的 TMD 成员资格…`,
    notEligible: (memberId) => `当前角色 ${memberId} 不在 TMD 成员名单中，不会上传资料。`,
    syncingRoster: (count) => `正在同步 TMD 当前名单（${count} 人）…`,
    rosterOk: (count) => `名单 ${count} 人、`,
    rosterFailed: (detail) => `名单未更新（${detail}）、`,
    syncingWeeklyTrials: "正在同步本周生活/战斗试炼与怪物面板…",
    weeklyTrialsOk: (skillCount, combatCount) => `本周试炼 ${skillCount}+${combatCount}、`,
    monstersIncomplete: "怪物面板尚未读取完整",
    weeklyTrialsFailed: (detail) => `试炼类型未更新（${detail}）、`,
    waitingMonsters: "怪物面板等待读取、",
    syncingSignups: "正在同步本周战斗试炼报名名单…",
    signupsOk: (summary) => `报名 ${summary}、`,
    signupsFailed: (detail) => `报名未更新（${detail}）、`,
    assignmentLoading: "正在读取最新战斗分工…",
    assignmentLoaded: (trial, skills) => `已高亮${trial}；技能：${skills}`,
    assignmentNotAssigned: "本周最新分工中没有找到你的战斗试炼。",
    assignmentUnavailable: "暂时无法读取最新战斗分工，未显示过期高亮。",
    assignmentCardsNotFound: "已读取最新分工，但尚未匹配到战斗试炼卡片。",
    lifeAssignmentLoading: "正在读取最新生活分工…",
    lifeAssignmentLoaded: (trial) => `已高亮应报名的生活试炼：${trial}`,
    lifeAssignmentNotAssigned: "本周最新生活分工中没有找到你的安排。",
    lifeAssignmentUnavailable: "暂时无法读取最新生活分工，未显示过期生活高亮。",
    lifeAssignmentCardsNotFound: "已读取生活分工，但尚未匹配到生活试炼卡片。",
    lifeExpectedBadge: "应报名",
    lifeMismatchBadge: "报名错误",
    lifeSignupMissing: (expected) => `生活试炼尚未报名：应报名${expected}`,
    lifeSignupMismatch: (actual, expected) => `生活试炼报名错误：当前报名${actual}，应报名${expected}`,
    lifeSignupOk: (trial) => `生活试炼报名正确：${trial}`,
    syncingLoadouts: "正在自动同步全部配装…",
    synced: (prefix, count, memberId) => `已同步${prefix}${count} 套配装（${memberId}）。`,
    syncFailed: (message) => `同步失败：${message}`,
  });
  const en = Object.freeze({
    ariaLabel: "TMD-guild-trial-sync",
    heading: "adudu · Guild Trial Sync",
    intro: "TMD only. After login, auto-syncs this week's trials, monster panels, roster, dual-boss signups, and all loadouts. Bind combat roles via the QQ bot.",
    waitingCharacter: "Waiting for character data",
    syncNow: "Sync now",
    exportBackup: "Export backup",
    expand: "Expand guild trial sync",
    collapse: "Minimize guild trial sync",
    categoryCombat: "Combat",
    categoryAll: "All actions",
    categorySkilling: "Skilling",
    categoryUnknown: "Unknown",
    characterLoaded: "Character data loaded.",
    waitingHydration: (current, total) => `Waiting for character data… (${current}/${total})`,
    syncTimeout: "Sync timed out",
    syncUnreachable: "Cannot reach the guild data service",
    waitingName: "Waiting for character name.",
    notTmdYet: "Could not confirm this character is in TMD. Open the guild panel and try again.",
    notTmdDetail: (detail) => `Could not confirm TMD membership (${detail}). Open the Guild panel, then Sync Now.`,
    waitingEquipmentAuto: "Loadout names found; waiting for equipment data…",
    waitingEquipmentManual: "Loadout names found, but equipment is not ready yet. Wait for the game to finish loading and try again.",
    checkingEligibility: (memberId) => `Checking TMD membership for ${memberId}…`,
    notEligible: (memberId) => `Character ${memberId} is not on the TMD roster; nothing will be uploaded.`,
    syncingRoster: (count) => `Syncing TMD roster (${count} members)…`,
    rosterOk: (count) => `roster ${count}, `,
    rosterFailed: (detail) => `roster not updated (${detail}), `,
    syncingWeeklyTrials: "Syncing this week's skilling/combat trials and monster panels…",
    weeklyTrialsOk: (skillCount, combatCount) => `weekly trials ${skillCount}+${combatCount}, `,
    monstersIncomplete: "monster panels incomplete",
    weeklyTrialsFailed: (detail) => `weekly trials not updated (${detail}), `,
    waitingMonsters: "waiting for monster panels, ",
    syncingSignups: "Syncing this week's combat trial signups…",
    signupsOk: (summary) => `signups ${summary}, `,
    signupsFailed: (detail) => `signups not updated (${detail}), `,
    assignmentLoading: "Loading the latest combat assignment…",
    assignmentLoaded: (trial, skills) => `Highlighted ${trial}; abilities: ${skills}`,
    assignmentNotAssigned: "You were not found in this week's latest combat assignment.",
    assignmentUnavailable: "The latest combat assignment is unavailable; stale highlights were cleared.",
    assignmentCardsNotFound: "The latest assignment loaded, but no combat trial card matched.",
    lifeAssignmentLoading: "Loading the latest life assignment…",
    lifeAssignmentLoaded: (trial) => `Highlighted your assigned life trial: ${trial}`,
    lifeAssignmentNotAssigned: "You were not found in this week's latest life assignment.",
    lifeAssignmentUnavailable: "The latest life assignment is unavailable; stale life highlights were cleared.",
    lifeAssignmentCardsNotFound: "The life assignment loaded, but no life trial card matched.",
    lifeExpectedBadge: "Join this",
    lifeMismatchBadge: "Wrong signup",
    lifeSignupMissing: (expected) => `No life trial signup: you should join ${expected}`,
    lifeSignupMismatch: (actual, expected) => `Wrong life trial signup: ${actual}; you should join ${expected}`,
    lifeSignupOk: (trial) => `Life trial signup is correct: ${trial}`,
    syncingLoadouts: "Auto-syncing all loadouts…",
    synced: (prefix, count, memberId) => `Synced ${prefix}${count} loadouts (${memberId}).`,
    syncFailed: (message) => `Sync failed: ${message}`,
  });
  function lang() {
    const stored = [
      readPageStorage("i18nextLng"),
      readPageStorage("i18nextLng-milkywayidle"),
      readPageStorage("mwi_language"),
    ].filter(Boolean).join(" ").toLowerCase();
    if (stored.includes("zh") || stored.includes("cn")) return zh;
    if (stored.includes("en")) return en;
    const htmlLang = (document.documentElement.lang || "").toLowerCase();
    if (htmlLang.includes("zh") || htmlLang.includes("cn")) return zh;
    if (htmlLang.includes("en")) return en;
    const host = location.hostname.toLowerCase();
    if (host.includes("milkywayidlecn")) return zh;
    const pageText = document.body?.innerText?.slice(0, 800) || "";
    if (/(选择角色|活跃角色|公会|总等级)/.test(pageText)) return zh;
    if (/\b(Character Select|Active Character|Guild|Total Level)\b/i.test(pageText)) return en;
    return en;
  }
  function tr(key, ...args) {
    const table = lang();
    const value = table[key] ?? en[key] ?? key;
    return typeof value === "function" ? value(...args) : value;
  }
  /** Page-origin storage. Sandboxed Edge/TM contexts must not use the extension localStorage. */
  function pageStorage() {
    try {
      const page = typeof unsafeWindow === "object" ? unsafeWindow : window;
      return page.localStorage ?? localStorage;
    } catch {
      return localStorage;
    }
  }
  function readPageStorage(key) {
    try {
      return pageStorage().getItem(key);
    } catch {
      return null;
    }
  }
  const state = {
    character: {},
    guild: {},
    guildCharacterMap: {},
    guildSharableCharacterMap: {},
    guildTrialSignupLevelMap: {},
    guildWeeklyTrialSet: {},
    guildTrialDetailMap: {},
    guildBuildingMap: {},
    guildBuildingLevelDict: {},
    guildBuildingDetailMap: {},
    combatMonsterDetailMap: {},
    loadouts: [],
    authorizedEquipment: [],
    itemByHash: new Map(),
    skills: [],
    learnedAbilities: [],
    auras: [],
  };
  const hydration = { attempt: 0, timer: 0, characterId: "" };
  const automaticSync = { timer: 0, running: false, lastSignature: "", suppressSchedule: false };
  const combatAssignmentState = {
    document: null,
    fetchedAt: 0,
    inFlight: false,
    timer: 0,
    pollTimer: 0,
    domTimer: 0,
    observer: null,
    lastMemberId: "",
    lastCardSignature: "",
    rendering: false,
  };
  const lifeAssignmentState = {
    document: null,
    fetchedAt: 0,
    inFlight: false,
    timer: 0,
    lastMemberId: "",
    mismatch: null,
  };
  let pageBridgeInstalled = false;
  let pageBridgeListenerInstalled = false;

  const mapLike = (value) => value && typeof value === "object"
    && typeof value.entries === "function" && typeof value.values === "function"
    && Number.isFinite(Number(value.size));
  const setLike = (value) => value && typeof value === "object"
    && typeof value.values === "function" && Number.isFinite(Number(value.size))
    && typeof value.entries === "function" && typeof value.get !== "function";
  const values = (value) => Array.isArray(value) ? value
    : mapLike(value) || setLike(value) ? [...value.values()]
      : value && typeof value === "object" ? Object.values(value) : [];
  const entries = (value) => mapLike(value) || setLike(value) ? [...value.entries()]
    : value && typeof value === "object" ? Object.entries(value) : [];
  const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const parseJson = (value) => {
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
    } catch { return null; }
  };
  // `initClientData` is LZString UTF-16 compressed on current MWI clients.
  // Keep a local decoder so weekly monster data does not depend on another
  // userscript exposing LZString in the page.
  const decompressUtf16 = (input) => {
    if (input == null || input === "") return "";
    const read = (index) => input.charCodeAt(index) - 32;
    const dictionary = [0, 1, 2];
    let enlargeIn = 4;
    let dictionarySize = 4;
    let bitWidth = 3;
    let previous = "";
    let current;
    let bits;
    let bit;
    let maxPower;
    let power;
    const result = [];
    const data = { value: read(0), position: 16384, index: 1 };
    const readBits = (width) => {
      let value = 0;
      maxPower = 2 ** width;
      power = 1;
      while (power !== maxPower) {
        bit = data.value & data.position;
        data.position >>= 1;
        if (data.position === 0) {
          data.position = 16384;
          data.value = read(data.index++);
        }
        value |= (bit > 0 ? 1 : 0) * power;
        power <<= 1;
      }
      return value;
    };
    bits = readBits(2);
    if (bits === 0) current = String.fromCharCode(readBits(8));
    else if (bits === 1) current = String.fromCharCode(readBits(16));
    else return "";
    dictionary[3] = current;
    previous = current;
    result.push(current);
    while (data.index <= input.length) {
      const code = readBits(bitWidth);
      if (code === 0) {
        dictionary[dictionarySize++] = String.fromCharCode(readBits(8));
        current = dictionarySize - 1;
        enlargeIn -= 1;
      } else if (code === 1) {
        dictionary[dictionarySize++] = String.fromCharCode(readBits(16));
        current = dictionarySize - 1;
        enlargeIn -= 1;
      } else if (code === 2) {
        return result.join("");
      } else {
        current = code;
      }
      if (enlargeIn === 0) {
        enlargeIn = 2 ** bitWidth;
        bitWidth += 1;
      }
      let entry;
      if (dictionary[current]) entry = dictionary[current];
      else if (current === dictionarySize) entry = previous + previous.charAt(0);
      else return "";
      result.push(entry);
      dictionary[dictionarySize++] = previous + entry.charAt(0);
      enlargeIn -= 1;
      previous = entry;
      if (enlargeIn === 0) {
        enlargeIn = 2 ** bitWidth;
        bitWidth += 1;
      }
    }
    return "";
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
  // MWI React/cache rows use wearableMap/abilityMap; the page bridge normalizes
  // them to equipment/abilities arrays. Snapshot building must accept both, or
  // auto-sync can POST names-only catalogs before the bridge reply arrives.
  const mapEntries = (value) => {
    if (!value || typeof value !== "object") return [];
    if (typeof value.entries === "function" && Number.isFinite(Number(value.size))) return [...value.entries()];
    return Object.entries(value);
  };
  // MWI wearableMap values are usually:
  //   "charId::/item_locations/...::/items/...::enhancement"
  // or an item hash that must be resolved via characterItemMap.
  const lookupItemByReference = (reference) => {
    if (!reference) return null;
    if (reference && typeof reference === "object") {
      if (reference.itemHrid || reference.hrid) return reference;
      const key = reference.hash ?? reference.itemHash ?? reference.itemKey ?? reference.id;
      return (key != null && state.itemByHash.get(String(key))) || null;
    }
    const raw = String(reference);
    const parts = raw.split("::");
    for (const key of [raw, parts[0], parts[2], parts[1]]) {
      if (key == null || key === "") continue;
      const hit = state.itemByHash.get(String(key));
      if (hit) return hit;
    }
    return null;
  };
  const referenceItemHrid = (reference) => {
    if (reference && typeof reference === "object") {
      return String(reference.itemHrid ?? reference.hrid ?? "");
    }
    const parts = String(reference ?? "").split("::");
    // Canonical WS/React format: charId::locationHrid::itemHrid::enhancementLevel
    if (parts.length >= 4 && String(parts[2]).startsWith("/items/")) return String(parts[2]);
    const fromLookup = lookupItemByReference(reference);
    if (fromLookup?.itemHrid || fromLookup?.hrid) {
      return String(fromLookup.itemHrid ?? fromLookup.hrid);
    }
    return parts.find((part) => String(part).startsWith("/items/")) || "";
  };
  const referenceEnhancementLevel = (reference) => {
    if (reference && typeof reference === "object") {
      return Number(reference.enhancementLevel ?? reference.enhancement_level ?? 0);
    }
    const parts = String(reference ?? "").split("::");
    if (parts.length >= 4 && Number.isFinite(Number(parts[3]))) return Number(parts[3]);
    const fromLookup = lookupItemByReference(reference);
    if (fromLookup && fromLookup.enhancementLevel != null) {
      return Number(fromLookup.enhancementLevel ?? 0);
    }
    return Number(parts.at(-1) ?? 0);
  };
  const indexCharacterItems = (equipment) => {
    for (const [key, item] of mapEntries(equipment)) {
      if (!item || typeof item !== "object") continue;
      state.itemByHash.set(String(key), item);
      if (item.hash != null) state.itemByHash.set(String(item.hash), item);
      if (item.itemHash != null) state.itemByHash.set(String(item.itemHash), item);
      if (item.id != null) state.itemByHash.set(String(item.id), item);
      if (item.itemHrid || item.hrid) {
        state.itemByHash.set(String(item.itemHrid ?? item.hrid), item);
      }
    }
  };
  const expandedLoadoutEquipment = (loadout) => {
    const direct = values(loadout?.equipment ?? loadout?.items ?? loadout?.loadoutItems)
      .filter((item) => item && typeof item === "object");
    if (direct.some((item) => item.itemHrid || item.item_hrid || item.hrid)) return direct;
    const wearableEntries = mapEntries(loadout?.wearableMap);
    if (wearableEntries.length) {
      return wearableEntries.flatMap(([locationHrid, reference]) => {
        if (!reference) return [];
        const itemHrid = referenceItemHrid(reference);
        if (!itemHrid) return [];
        return [{
          locationHrid: String(locationHrid),
          itemHrid,
          enhancementLevel: referenceEnhancementLevel(reference),
        }];
      });
    }
    return [];
  };
  const expandedLoadoutAbilities = (loadout) => {
    const direct = values(loadout?.abilities ?? loadout?.combatAbilities ?? loadout?.combat_abilities)
      .filter((item) => item && typeof item === "object");
    if (direct.some((item) => item.abilityHrid || item.ability_hrid || item.hrid)) return direct;
    const triggerMap = loadout?.abilityCombatTriggersMap || {};
    return mapEntries(loadout?.abilityMap).flatMap(([slot, abilityReference]) => {
      if (!abilityReference) return [];
      const abilityHrid = String(
        typeof abilityReference === "object"
          ? abilityReference.abilityHrid ?? abilityReference.hrid ?? ""
          : abilityReference
      );
      if (!abilityHrid.startsWith("/")) return [];
      const slotNumber = Number(String(slot).match(/\d+/)?.[0] ?? slot);
      return [{
        slot: Math.max(0, slotNumber - 1),
        abilityHrid,
        level: Number(abilityReference?.level ?? 1),
        triggers: values(triggerMap instanceof Map ? triggerMap.get(abilityHrid) : triggerMap[abilityHrid]),
      }];
    });
  };
  const loadoutEquipmentPool = () => state.loadouts.flatMap((loadout) => expandedLoadoutEquipment(loadout));
  const loadoutRichness = (loadouts) => values(loadouts).reduce((score, loadout) => {
    const normalizedEquipment = expandedLoadoutEquipment(loadout).filter((item) => item?.itemHrid || item?.hrid).length;
    const normalizedAbilities = expandedLoadoutAbilities(loadout).filter((item) => item?.abilityHrid || item?.hrid).length;
    return score
      + normalizedEquipment * 1000
      + values(loadout?.wearableMap).length * 100
      + normalizedAbilities * 10
      + 1;
  }, 0);
  const loadoutIdentity = (loadout, index = 0) => String(
    loadout?.loadoutId ?? loadout?.loadout_id ?? loadout?.id
    ?? `${loadout?.actionTypeHrid ?? loadout?.action_type_hrid ?? ""}\u0000${loadout?.name ?? index}`
  );
  const mergeLoadouts = (current, incoming) => {
    const merged = new Map();
    values(current).forEach((loadout, index) => merged.set(loadoutIdentity(loadout, index), loadout));
    values(incoming).forEach((loadout, index) => {
      const key = loadoutIdentity(loadout, index);
      const previous = merged.get(key);
      if (!previous) {
        merged.set(key, loadout);
        return;
      }
      const previousScore = loadoutRichness([previous]);
      const nextScore = loadoutRichness([loadout]);
      // Prefer the hydrated record, but retain useful scalar metadata from the
      // other view. React exposes several representations of the same loadout
      // during login and a names-only view must never erase wearableMap or a
      // bridge-normalized equipment array.
      const primary = nextScore >= previousScore ? loadout : previous;
      const secondary = nextScore >= previousScore ? previous : loadout;
      const equipment = expandedLoadoutEquipment(primary).length
        ? expandedLoadoutEquipment(primary)
        : expandedLoadoutEquipment(secondary);
      const abilities = expandedLoadoutAbilities(primary).length
        ? expandedLoadoutAbilities(primary)
        : expandedLoadoutAbilities(secondary);
      merged.set(key, {
        ...secondary,
        ...primary,
        ...(equipment.length ? { equipment } : {}),
        ...(abilities.length ? { abilities } : {}),
        wearableMap: primary.wearableMap ?? secondary.wearableMap,
        abilityMap: primary.abilityMap ?? secondary.abilityMap,
      });
    });
    return [...merged.values()];
  };

  function applyCharacterData(candidate) {
    const data = object(candidate);
    const characterInfo = object(data.characterInfo);
    const character = data.character ?? characterInfo.character;
    if (character && typeof character === "object") state.character = character;
    const guild = data.guild ?? characterInfo.guild;
    if (guild && typeof guild === "object") {
      // Explicit fields: Edge/Chromium guild objects may expose id/name via
      // getters that object-spread does not always copy into state.guild.
      state.guild = {
        ...state.guild,
        ...guild,
        id: guild.id ?? guild.guildId ?? state.guild.id,
        guildId: guild.guildId ?? guild.id ?? state.guild.guildId,
        name: guild.name ?? guild.guildName ?? state.guild.name,
        guildName: guild.guildName ?? guild.name ?? state.guild.guildName,
      };
    }
    const guildName = data.guildName ?? character?.guildName ?? characterInfo.character?.guildName
      ?? guild?.name ?? guild?.guildName;
    if (typeof guildName === "string" && guildName.trim()) state.guild.name = guildName.trim();
    const guildId = data.guildId ?? data.guildID ?? character?.guildId ?? character?.guildID
      ?? guild?.id ?? guild?.guildId;
    if (guildId != null && guildId !== "" && Number(guildId) > 0) {
      state.guild.id = Number(guildId);
      if (state.character && typeof state.character === "object") {
        if (state.character.guildId == null && state.character.guildID == null) {
          state.character.guildId = Number(guildId);
        }
        if (!state.character.guildName && state.guild.name) {
          state.character.guildName = state.guild.name;
        }
      }
    }
    const guildCharacterMap = data.guildCharacterMap ?? data.guildCharacterDict;
    if (guildCharacterMap && typeof guildCharacterMap === "object") state.guildCharacterMap = guildCharacterMap;
    const guildSharableCharacterMap = data.guildSharableCharacterMap ?? data.guildSharableCharacterDict;
    if (guildSharableCharacterMap && typeof guildSharableCharacterMap === "object") state.guildSharableCharacterMap = guildSharableCharacterMap;
    const guildTrialSignupLevelMap = data.guildTrialSignupLevelMap ?? data.guildTrialSignupLevelDict;
    if (guildTrialSignupLevelMap && typeof guildTrialSignupLevelMap === "object") state.guildTrialSignupLevelMap = guildTrialSignupLevelMap;
    const guildWeeklyTrialSet = data.guildWeeklyTrialSet ?? data.weeklyGuildTrialSet;
    if (guildWeeklyTrialSet && typeof guildWeeklyTrialSet === "object") state.guildWeeklyTrialSet = guildWeeklyTrialSet;
    const guildTrialDetailMap = data.guildTrialDetailMap ?? data.guildTrialDetailDict;
    if (guildTrialDetailMap && typeof guildTrialDetailMap === "object") state.guildTrialDetailMap = guildTrialDetailMap;
    const guildBuildingLevelDict = data.guildBuildingLevelDict ?? data.guildBuildingLevelMap
      ?? data.guild?.guildBuildingLevelMap ?? data.guild?.guildBuildingLevelDict;
    if (guildBuildingLevelDict && typeof guildBuildingLevelDict === "object") {
      state.guildBuildingLevelDict = guildBuildingLevelDict;
    }
    const guildBuildingMap = data.guildBuildingMap ?? data.guildBuildingDict;
    if (guildBuildingMap && typeof guildBuildingMap === "object") state.guildBuildingMap = guildBuildingMap;
    const guildBuildingDetailMap = data.guildBuildingDetailMap ?? data.guildBuildingDetailDict;
    if (guildBuildingDetailMap && typeof guildBuildingDetailMap === "object") state.guildBuildingDetailMap = guildBuildingDetailMap;
    const combatMonsterDetailMap = data.combatMonsterDetailMap ?? data.combatMonsterDetailDict;
    if (combatMonsterDetailMap && typeof combatMonsterDetailMap === "object") state.combatMonsterDetailMap = combatMonsterDetailMap;
    const equipment = data.equipment ?? data.inventory ?? data.characterItems ?? data.characterItemMap
      ?? characterInfo.characterItems ?? characterInfo.characterItemMap;
    if (equipment) {
      indexCharacterItems(equipment);
      state.authorizedEquipment = mergeAuthorizedEquipment(state.authorizedEquipment, equipment);
    }
    const byLocation = data.characterItemByLocationMap ?? data.characterItemsByLocation;
    if (byLocation) indexCharacterItems(byLocation);
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
    if (loadouts) {
      const nextLoadouts = values(loadouts);
      state.loadouts = mergeLoadouts(state.loadouts, nextLoadouts);
    }
  }

  /**
   * Modern MWI keeps the initial character payload in these exact same-origin
   * cache keys. This is a fallback for userscripts installed after the initial
   * WebSocket message; it reads no general storage or authentication data.
   */
  function hydrateFromGameCache() {
    const init = parseJson(readPageStorage("init_character_data"));
    if (init) applyCharacterData(init.data ?? init.payload ?? init);
    // Current MWI clients store the initial event stream under initClientData.
    // It can be plain JSON or LZString-compressed JSON, depending on client
    // version.  This stays entirely same-origin and read-only.
    const initClientRaw = readPageStorage("initClientData");
    if (initClientRaw) {
      const page = typeof unsafeWindow === "object" ? unsafeWindow : window;
      const lz = page.LZString ?? window.LZString;
      const initClient = parseJson(initClientRaw)
        ?? parseJson(lz?.decompressFromUTF16?.(initClientRaw))
        ?? parseJson(page.__sunnyMwi__?.lzDecompressUTF16?.(initClientRaw))
        ?? parseJson(decompressUtf16(initClientRaw))
        ?? parseJson(lz?.decompressFromBase64?.(initClientRaw));
      if (initClient) applyCharacterData(initClient.data ?? initClient.payload ?? initClient);
    }
    const skills = parseJson(readPageStorage("characterSkills"));
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
      const queuePlannerState = page.MWI_QUEUE_PLANNER?.getGameCore?.()?.state;
      if (queuePlannerState && typeof queuePlannerState === "object") applyCharacterTree(queuePlannerState);
      const queue = roots.flatMap((root) => {
        const key = Object.keys(root).find((name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$") || name.startsWith("__react"));
        return key ? [root[key]] : [];
      });
      const seen = new Set();
      let visited = 0;
      while (queue.length && visited < 8000) {
        const fiber = queue.shift();
        if (!fiber || typeof fiber !== "object" || seen.has(fiber)) continue;
        seen.add(fiber); visited += 1;
        const candidate = fiber.stateNode?.state;
        if (candidate && typeof candidate === "object" && (candidate.characterLoadoutDict || candidate.characterLoadoutMap || candidate.characterLabyrinth || candidate.combatUnit || candidate.gameConn || candidate.guildCharacterMap || candidate.guildSharableCharacterMap || candidate.guildTrialSignupLevelDict || candidate.guildWeeklyTrialSet || candidate.guildBuildingLevelDict || candidate.guildBuildingLevelMap || candidate.guild)) {
          applyCharacterTree(candidate);
        }
        if (fiber.return) queue.push(fiber.return);
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      refresh();
      return hasCharacterData();
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
      if (value.character || value.characterInfo || value.characterLoadoutDict || value.characterLoadoutMap || value.characterItems || value.characterSkills || value.guildCharacterMap || value.guildSharableCharacterMap || value.guildTrialSignupLevelDict || value.guildWeeklyTrialSet || value.guildTrialDetailMap || value.combatMonsterDetailMap || value.guildBuildingLevelDict || value.guildBuildingLevelMap || value.guild) applyCharacterData(value);
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
      const mapEntries = (value) => {
        if (!value || typeof value !== "object") return [];
        if (typeof value.entries === "function" && Number.isFinite(Number(value.size))) return [...value.entries()];
        return Object.entries(value);
      };
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
      const equipmentFromLoadout = (loadout) => {
        const direct = equipment(loadout.equipment ?? loadout.items ?? loadout.loadoutItems);
        if (direct.length) return direct;
        return equipment(mapEntries(loadout.wearableMap).flatMap(([locationHrid, reference]) => {
          if (!reference) return [];
          const parts = String(reference ?? "").split("::");
          let itemHrid = string(
            typeof reference === "object"
              ? reference.itemHrid ?? reference.hrid ?? ""
              : ""
          );
          if (!itemHrid && parts.length >= 4 && String(parts[2]).startsWith("/items/")) {
            itemHrid = string(parts[2]);
          }
          if (!itemHrid) {
            itemHrid = string(parts.find((part) => String(part).startsWith("/items/")) || "");
          }
          if (!itemHrid) return [];
          const enhancementLevel = count(
            typeof reference === "object"
              ? reference.enhancementLevel ?? reference.enhancement_level
              : (parts.length >= 4 ? parts[3] : parts.at(-1))
          );
          return [{ locationHrid: string(locationHrid), itemHrid, enhancementLevel }];
        }));
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
      const abilitiesFromLoadout = (loadout) => {
        const direct = abilities(loadout.abilities ?? loadout.combatAbilities ?? loadout.combat_abilities);
        if (direct.length) return direct;
        const triggerMap = loadout.abilityCombatTriggersMap || {};
        return abilities(mapEntries(loadout.abilityMap).flatMap(([slot, abilityReference]) => {
          if (!abilityReference) return [];
          const abilityHrid = string(
            typeof abilityReference === "object"
              ? abilityReference.abilityHrid ?? abilityReference.hrid ?? ""
              : abilityReference
          );
          if (!abilityHrid.startsWith("/")) return [];
          const slotNumber = Number(String(slot).match(/\d+/)?.[0] ?? slot);
          return [{
            slot: Math.max(0, slotNumber - 1),
            abilityHrid,
            level: Math.max(1, count(abilityReference?.level, 1)),
            triggers: list(triggerMap instanceof Map ? triggerMap.get(abilityHrid) : triggerMap[abilityHrid]),
          }];
        }));
      };
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
        const resolved = resolveOwnedEquipment(equipmentFromLoadout(loadout));
        const slots = abilitiesFromLoadout(loadout);
        if (!resolved.equipment.length || !slots.length || resolved.missing) return null;
        const sourceLoadoutId = loadout.loadoutId ?? loadout.loadout_id ?? loadout.id;
        return { buildId: string(loadout.buildId) || `loadout:${string(sourceLoadoutId) || index + 1}`, ...(sourceLoadoutId == null ? {} : { sourceLoadoutId: count(sourceLoadoutId) }), name: string(loadout.name) || `Combat loadout ${index + 1}`, approvedByMember: true, capturedAt, equipment: resolved.equipment, abilities: slots, simulationReady: true, issues: [] };
      }).filter(Boolean);
      const loadoutCatalog = list(input.loadouts).slice(0, 64).map((loadout, index) => {
        const actionTypeHrid = string(loadout.actionTypeHrid ?? loadout.action_type_hrid) || "/action_types/all";
        const category = actionTypeHrid === "/action_types/combat" ? "combat" : actionTypeHrid === "/action_types/all" ? "all" : actionTypeHrid.startsWith("/action_types/") ? "profession" : "unknown";
        const resolved = resolveOwnedEquipment(equipmentFromLoadout(loadout));
        const slots = abilitiesFromLoadout(loadout);
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
    if (type === "items_updated") {
      applyCharacterData({ characterItems: data.endCharacterItems ?? data.characterItems });
    }
    if (type === "loadouts_updated") {
      const updated = data.loadouts ?? data.combatLoadouts ?? data.characterLoadoutMap ?? data.characterLoadoutDict ?? data;
      state.loadouts = mergeLoadouts(state.loadouts, values(updated));
    }
    applyCharacterData(data);
    refresh();
  }

  /**
   * Observe the game's already-created WebSocket without replacing it. MWI
   * reads MessageEvent.data to dispatch every server packet, so wrapping that
   * native getter at document-start captures init_character_data even when the
   * socket constructor ran before our page bridge. The wrapper is read-only
   * and always returns the original payload unchanged.
   */
  function observePageMessages(page, onPacket) {
    try {
      if (!page || page.__ADUDU_GUILD_TRIAL_MESSAGE_OBSERVER__) return false;
      const prototype = page.MessageEvent?.prototype;
      const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "data");
      if (!descriptor?.get || descriptor.configurable === false) return false;
      const originalGet = descriptor.get;
      const seen = new WeakSet();
      Object.defineProperty(prototype, "data", {
        ...descriptor,
        get() {
          const message = originalGet.call(this);
          if (
            typeof message === "string"
            && !seen.has(this)
            && (
              message.includes('"init_character_data"')
              || message.includes('"loadouts_updated"')
              || message.includes('"items_updated"')
              || message.includes('"guildCharacterMap"')
              || message.includes('"guildSharableCharacterMap"')
              || message.includes('"guildName"')
              || message.includes('"guildWeeklyTrialSet"')
            )
          ) {
            seen.add(this);
            queueMicrotask(() => {
              try { onPacket(JSON.parse(message)); } catch { /* ignore unrelated frames */ }
            });
          }
          return message;
        },
      });
      page.__ADUDU_GUILD_TRIAL_MESSAGE_OBSERVER__ = true;
      return true;
    } catch {
      return false;
    }
  }

  function installDirectMessageObserver() {
    const page = typeof unsafeWindow === "object" ? unsafeWindow : window;
    observePageMessages(page, recordPacket);
  }

  function pageBridgeMain(channel) {
    if (window.__ADUDU_GUILD_TRIAL_BRIDGE__) return;
    window.__ADUDU_GUILD_TRIAL_BRIDGE__ = true;
    // Edge/TM document-start can miss the userscript-side MessageEvent hook.
    // Install the same read-only getter in true page context before React/WS.
    try {
      if (!window.__ADUDU_GUILD_TRIAL_PAGE_MESSAGE_OBSERVER__) {
        const prototype = window.MessageEvent?.prototype;
        const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "data");
        if (descriptor?.get && descriptor.configurable !== false) {
          const originalGet = descriptor.get;
          const seen = new WeakSet();
          Object.defineProperty(prototype, "data", {
            ...descriptor,
            get() {
              const message = originalGet.call(this);
              if (
                typeof message === "string"
                && !seen.has(this)
                && (
                  message.includes('"init_character_data"')
                  || message.includes('"loadouts_updated"')
                  || message.includes('"items_updated"')
                  || message.includes('"guildCharacterMap"')
                  || message.includes('"guildSharableCharacterMap"')
                  || message.includes('"guildName"')
                  || message.includes('"guildWeeklyTrialSet"')
                )
              ) {
                seen.add(this);
                queueMicrotask(() => {
                  try {
                    window.postMessage(
                      { source: channel, type: "packet", packet: JSON.parse(message) },
                      window.location.origin,
                    );
                  } catch { /* ignore unrelated frames */ }
                });
              }
              return message;
            },
          });
          window.__ADUDU_GUILD_TRIAL_PAGE_MESSAGE_OBSERVER__ = true;
        }
      }
    } catch { /* MessageEvent hook unavailable */ }
    const mapLike = (value) => value && typeof value === "object"
      && typeof value.entries === "function" && typeof value.values === "function"
      && Number.isFinite(Number(value.size));
    const values = (value) => Array.isArray(value) ? value : mapLike(value) ? [...value.values()] : value && typeof value === "object" ? Object.values(value) : [];
    const entries = (value) => mapLike(value) ? [...value.entries()] : value && typeof value === "object" ? Object.entries(value) : [];
    const dictionary = (value) => mapLike(value) ? Object.fromEntries(value) : value && typeof value === "object" ? value : {};
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
        const wearableEntries = entries(loadout?.wearableMap);
        const equipmentEntries = wearableEntries.length
          ? wearableEntries
          : entries(loadout?.equipment || loadout?.items);
        const equipment = equipmentEntries.flatMap(([locationHrid, reference]) => {
          if (!reference) return [];
          const referenceKey = typeof reference === "object"
            ? reference.hash ?? reference.itemHash ?? reference.itemKey ?? reference.id
            : reference;
          const parts = String(reference ?? "").split("::");
          let item = typeof reference === "object" && (reference.itemHrid || reference.hrid)
            ? reference
            : null;
          if (!item) {
            for (const key of [referenceKey, parts[0], parts[2], parts[1]]) {
              if (key == null || key === "") continue;
              item = itemByHash.get(String(key));
              if (item) break;
            }
          }
          const itemHrid = item?.itemHrid || item?.hrid
            || (parts.length >= 4 && String(parts[2]).startsWith("/items/") ? parts[2] : "")
            || parts.find((part) => String(part).startsWith("/items/"))
            || "";
          const enhancementLevel = Number(
            item?.enhancementLevel
            ?? (parts.length >= 4 ? parts[3] : undefined)
            ?? parts.at(-1)
            ?? 0
          );
          return itemHrid ? [{ locationHrid: String(locationHrid), itemHrid, enhancementLevel }] : [];
        });
        const triggerMap = loadout?.abilityCombatTriggersMap || {};
        const abilities = entries(loadout?.abilityMap || loadout?.abilities || loadout?.combatAbilities).flatMap(([slot, abilityReference]) => {
          if (!abilityReference) return [];
          const hrid = String(
            typeof abilityReference === "object"
              ? abilityReference.abilityHrid ?? abilityReference.hrid ?? ""
              : abilityReference
          );
          if (!hrid.startsWith("/")) return [];
          const slotNumber = Number(String(slot).match(/\d+/)?.[0] ?? slot);
          return [{
            slot: Math.max(0, slotNumber - 1),
            abilityHrid: hrid,
            level: Number(abilityReference?.level ?? abilityLevelByHrid.get(hrid) ?? 1),
            triggers: values(triggerMap instanceof Map ? triggerMap.get(hrid) : triggerMap[hrid]),
          }];
        });
        return {
          loadoutId: loadout?.id ?? loadout?.loadoutId,
          name: loadout?.name,
          actionTypeHrid: loadout?.actionTypeHrid,
          equipment,
          abilities,
          wearableMap: loadout?.wearableMap,
          abilityMap: loadout?.abilityMap,
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
        guildTrialSignupLevelMap: dictionary(gameState?.guildTrialSignupLevelMap || gameState?.guildTrialSignupLevelDict),
        guildWeeklyTrialSet: gameState?.guildWeeklyTrialSet || gameState?.weeklyGuildTrialSet || {},
        guildTrialDetailMap: dictionary(gameState?.guildTrialDetailMap || gameState?.guildTrialDetailDict),
        guildBuildingLevelDict: dictionary(
          gameState?.guildBuildingLevelDict
          || gameState?.guildBuildingLevelMap
          || gameState?.guild?.guildBuildingLevelMap,
        ),
        guildBuildingDetailMap: dictionary(gameState?.guildBuildingDetailMap || gameState?.guildBuildingDetailDict),
        combatMonsterDetailMap: dictionary(gameState?.combatMonsterDetailMap || gameState?.combatMonsterDetailDict),
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
      const consider = (candidate) => {
        const result = compact(candidate);
        if (!result) return;
        const loadoutDetailScore = result.loadouts.reduce((sum, loadout) =>
          sum + loadout.equipment.length * 1000 + loadout.abilities.length * 100 + 1
        , 0);
        const next = loadoutDetailScore * 10000
          + Object.keys(result.guildCharacterMap).length * 100
          + Object.keys(result.guildTrialSignupLevelMap).length * 10
          + result.characterItems.length
          + result.characterSkills.length;
        if (next > score) { best = result; score = next; }
      };
      consider(window.MWI_QUEUE_PLANNER?.getGameCore?.()?.state);
      for (let index = 0; index < queue.length && index < 8000; index += 1) {
        const fiber = queue[index];
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        consider(fiber.stateNode?.state);
        if (fiber.return) queue.push(fiber.return);
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      if (best) window.postMessage({ source: channel, type: "state", payload: best }, window.location.origin);
    };
    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket === "function") {
      window.WebSocket = class AduduObservedWebSocket extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", (event) => {
            if (typeof event.data !== "string") return;
            try {
              const packet = JSON.parse(event.data);
              window.postMessage({ source: channel, type: "packet", packet }, window.location.origin);
            } catch { /* non-JSON game frames are irrelevant */ }
          });
        }
      };
    }
    window.addEventListener("message", (event) => { if (event.origin === window.location.origin && event.data?.source === channel && event.data?.type === "request") recover(); });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", recover, { once: true }); else recover();
  }

  function installPageBridge() {
    if (!pageBridgeListenerInstalled) {
      pageBridgeListenerInstalled = true;
      window.addEventListener("message", (event) => {
        if (event.origin !== location.origin || event.data?.source !== PAGE_BRIDGE_CHANNEL) return;
        if (event.data?.type === "packet") {
          recordPacket(event.data.packet);
          return;
        }
        if (event.data?.type !== "state") return;
        applyCharacterData(event.data.payload);
        refresh();
        if (hasCharacterData()) {
          clearTimeout(hydration.timer);
          hydration.timer = 0;
          setStatus(tr("characterLoaded"));
        }
      });
    }
    if (!document.documentElement || pageBridgeInstalled) return;
    pageBridgeInstalled = true;
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
    state.guildTrialSignupLevelMap = {};
    state.guildWeeklyTrialSet = {};
    state.loadouts = [];
    state.authorizedEquipment = [];
    state.itemByHash = new Map();
    state.skills = [];
    state.learnedAbilities = [];
    state.auras = [];
    clearTimeout(combatAssignmentState.timer);
    clearTimeout(lifeAssignmentState.timer);
    combatAssignmentState.document = null;
    combatAssignmentState.fetchedAt = 0;
    combatAssignmentState.lastMemberId = "";
    combatAssignmentState.lastCardSignature = "";
    lifeAssignmentState.document = null;
    lifeAssignmentState.fetchedAt = 0;
    lifeAssignmentState.lastMemberId = "";
    lifeAssignmentState.mismatch = null;
    clearCombatAssignmentUi();
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
      setStatus(tr("characterLoaded"));
      return;
    }
    setStatus(tr("waitingHydration", hydration.attempt + 1, HYDRATION_RETRY_DELAYS_MS.length + 1), true);
    window.postMessage({ source: PAGE_BRIDGE_CHANNEL, type: "request" }, location.origin);
    if (hydration.attempt >= HYDRATION_RETRY_DELAYS_MS.length) return;
    const delay = HYDRATION_RETRY_DELAYS_MS[hydration.attempt];
    hydration.attempt += 1;
    hydration.timer = setTimeout(() => requestCharacterData(), delay);
  }

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
  function tmdConfirmDetail() {
    const guild = detectedGameGuild();
    const parts = [];
    if (guild.name !== FIXED_GUILD_ID) {
      parts.push(guild.name ? `guild=${guild.name}` : "missing guild name");
    }
    if (guild.id == null) parts.push("missing guild id");
    const characterGuildId = Number(state.character.guildId ?? state.character.guildID);
    if (Number.isInteger(characterGuildId) && guild.id != null && characterGuildId !== guild.id) {
      parts.push(`character guildId=${characterGuildId}≠${guild.id}`);
    }
    return parts.join("; ") || "incomplete guild state";
  }
  function confirmedTmdGuild() {
    const guild = detectedGameGuild();
    const characterGuildId = Number(state.character.guildId ?? state.character.guildID);
    return guild.name === FIXED_GUILD_ID
      && guild.id != null
      && (!Number.isInteger(characterGuildId) || characterGuildId === guild.id);
  }
  /** Ask the page bridge to re-read React/core state; Edge often needs this after opening Guild. */
  function requestPageBridgeState(timeoutMs = 900) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(confirmedTmdGuild());
      };
      const onMessage = (event) => {
        if (event.origin !== location.origin || event.data?.source !== PAGE_BRIDGE_CHANNEL) return;
        if (event.data?.type === "state" || event.data?.type === "packet") {
          // Existing listener applies payload; wait one tick then re-check.
          queueMicrotask(() => {
            hydrateFromLiveGame();
            finish();
          });
        }
      };
      const timer = setTimeout(() => {
        hydrateFromGameCache();
        hydrateFromLiveGame();
        finish();
      }, timeoutMs);
      window.addEventListener("message", onMessage);
      installPageBridge();
      window.postMessage({ source: PAGE_BRIDGE_CHANNEL, type: "request" }, location.origin);
    });
  }
  async function ensureTmdGuildConfirmed() {
    hydrateFromGameCache();
    hydrateFromLiveGame();
    if (confirmedTmdGuild()) return true;
    return requestPageBridgeState();
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
  const COMBAT_TRIAL_NAMES = Object.freeze({
    "/guild_combat/badger": "试炼獾",
    "/guild_combat/chameleon": "试炼变色龙",
    "/guild_combat/jellyfish": "试炼水母",
    "/guild_combat/hedgehog": "试炼刺猬",
    "/guild_combat/swarm": "试炼虫群",
  });
  // API/QQ keep Chinese canonical names; UI status may show English labels.
  const COMBAT_TRIAL_NAMES_EN = Object.freeze({
    "/guild_combat/badger": "Trial Badger",
    "/guild_combat/chameleon": "Trial Chameleon",
    "/guild_combat/jellyfish": "Trial Jellyfish",
    "/guild_combat/hedgehog": "Trial Hedgehog",
    "/guild_combat/swarm": "Trial Swarm",
  });
  function displayCombatTrialName(trialHrid) {
    return (lang() === zh ? COMBAT_TRIAL_NAMES : COMBAT_TRIAL_NAMES_EN)[trialHrid]
      ?? COMBAT_TRIAL_NAMES[trialHrid]
      ?? String(trialHrid).split("/").at(-1);
  }
  const COMBAT_TRIAL_MONSTERS = Object.freeze({
    "/guild_combat/badger": "/monsters/guild_trial_badger",
    "/guild_combat/chameleon": "/monsters/guild_trial_chameleon",
    "/guild_combat/jellyfish": "/monsters/guild_trial_jellyfish",
    "/guild_combat/hedgehog": "/monsters/guild_trial_hedgehog",
    "/guild_combat/swarm": "/monsters/guild_trial_swarm",
  });
  const SKILL_TRIAL_NAMES = Object.freeze({
    "/guild_skilling/alchemy": "炼金",
    "/guild_skilling/brewing": "冲泡",
    "/guild_skilling/cheesesmithing": "奶酪锻造",
    "/guild_skilling/cooking": "烹饪",
    "/guild_skilling/crafting": "制作",
    "/guild_skilling/enhancing": "强化",
    "/guild_skilling/foraging": "采摘",
    "/guild_skilling/milking": "挤奶",
    "/guild_skilling/tailoring": "缝纫",
    "/guild_skilling/woodcutting": "伐木",
  });
  const dictionaryValue = (dictionary, key) => dictionary instanceof Map
    ? dictionary.get(key)
    : dictionary?.[key];
  const firstFinite = (...candidates) => {
    for (const candidate of candidates) {
      if (candidate == null || candidate === "") continue;
      const number = Number(candidate);
      if (Number.isFinite(number)) return number;
    }
    return null;
  };
  const includeNumber = (target, key, value, transform = (number) => number) => {
    if (value == null) return;
    const next = transform(value);
    if (Number.isFinite(next)) target[key] = next;
  };
  const ratingMap = (source, specification) => {
    const result = {};
    for (const [key, aliases] of Object.entries(specification)) {
      includeNumber(result, key, firstFinite(...aliases.map((alias) => source?.[alias])));
    }
    return result;
  };
  function compactMonsterDetail(monsterHrid, rawDetail) {
    const detail = object(rawDetail);
    const combat = object(detail.combatDetails ?? detail.combatDetail);
    const combatStats = object(combat.combatStats ?? detail.combatStats);
    const result = {
      monsterHrid,
      name: String(detail.name ?? detail.displayName ?? "").slice(0, 100),
      level: Math.max(1, Math.trunc(firstFinite(detail.level, combat.level, 100))),
      combatStyleHrids: values(combatStats.combatStyleHrids ?? combat.combatStyleHrids)
        .map(String)
        .filter((hrid) => hrid.startsWith("/"))
        .slice(0, 8),
      damageTypeHrid: String(combatStats.damageType ?? combat.damageTypeHrid ?? "").slice(0, 256),
      accuracy: ratingMap(combat, {
        stab: ["stabAccuracyRating", "stabAccuracy"],
        slash: ["slashAccuracyRating", "slashAccuracy"],
        smash: ["smashAccuracyRating", "smashAccuracy", "crushAccuracyRating", "crushAccuracy"],
        ranged: ["rangedAccuracyRating", "rangedAccuracy"],
        magic: ["magicAccuracyRating", "magicAccuracy"],
      }),
      damage: ratingMap(combat, {
        defensive: ["defensiveMaxDamage", "defensiveDamage"],
        stab: ["stabMaxDamage", "stabDamage"],
        slash: ["slashMaxDamage", "slashDamage"],
        smash: ["smashMaxDamage", "smashDamage", "crushMaxDamage", "crushDamage"],
        ranged: ["rangedMaxDamage", "rangedDamage"],
        magic: ["magicMaxDamage", "magicDamage"],
      }),
      evasion: ratingMap(combat, {
        stab: ["stabEvasionRating", "stabEvasion"],
        slash: ["slashEvasionRating", "slashEvasion"],
        smash: ["smashEvasionRating", "smashEvasion", "crushEvasionRating", "crushEvasion"],
        ranged: ["rangedEvasionRating", "rangedEvasion"],
        magic: ["magicEvasionRating", "magicEvasion"],
      }),
      resistance: ratingMap(combat, {
        water: ["totalWaterResistance", "waterResistance"],
        nature: ["totalNatureResistance", "natureResistance"],
        fire: ["totalFireResistance", "fireResistance"],
      }),
      abilities: values(detail.abilities ?? combat.abilities).flatMap((ability) => {
        const abilityHrid = String(ability?.abilityHrid ?? ability?.hrid ?? "");
        if (!abilityHrid.startsWith("/abilities/")) return [];
        return [{
          abilityHrid,
          level: Math.max(1, Math.trunc(firstFinite(ability?.level, 1))),
          minDifficultyTier: Math.max(0, Math.trunc(firstFinite(ability?.minDifficultyTier, 0))),
        }];
      }).slice(0, 20),
    };
    const attackInterval = firstFinite(
      combatStats.attackInterval,
      combat.attackInterval,
      detail.attackInterval,
    );
    includeNumber(result, "attackIntervalSeconds", attackInterval, (number) =>
      Math.round((number > 1_000_000 ? number / 1_000_000_000 : number) * 1000) / 1000
    );
    const castSpeed = firstFinite(
      combat.totalCastSpeed,
      combat.castSpeed,
      combatStats.castSpeed,
      detail.castSpeed,
    );
    includeNumber(result, "castSpeedPercent", castSpeed, (number) =>
      Math.round((Math.abs(number) <= 2 ? number * 100 : number) * 1000) / 1000
    );
    includeNumber(result, "abilityHaste", firstFinite(
      combat.totalAbilityHaste,
      combat.abilityHaste,
      combatStats.abilityHaste,
      detail.abilityHaste,
    ));
    includeNumber(result, "maxHp", firstFinite(combat.maxHitpoints, combat.maxHp, detail.maxHitpoints, detail.maxHp));
    includeNumber(result, "maxMp", firstFinite(combat.maxManapoints, combat.maxMp, detail.maxManapoints, detail.maxMp));
    includeNumber(result, "armor", firstFinite(combat.totalArmor, combat.armor, detail.armor));
    includeNumber(result, "tenacity", firstFinite(combat.totalTenacity, combat.tenacity, combatStats.tenacity, detail.tenacity));
    includeNumber(result, "threat", firstFinite(combat.totalThreat, combat.threat, combatStats.threat, detail.threat));
    return result;
  }
  const TRIAL_CAPACITY_FIELDS = [
    "maxParticipants",
    "maxParticipantCount",
    "participantLimit",
    "maxSlotCount",
    "capacity",
    "signupLimit",
    "maxSignups",
  ];
  const TRIAL_SIGNUP_COUNT_FIELDS = [
    "signedUpCount",
    "signupCount",
    "registeredCount",
    "currentSignups",
    "participantCount",
  ];
  const GUILD_TRIAL_CAPACITY_FIELDS = {
    skilling: [
      "skillingTrialMaxParticipants",
      "maxSkillingTrialParticipants",
      "skillingTrialParticipantLimit",
    ],
    combat: [
      "combatTrialMaxParticipants",
      "maxCombatTrialParticipants",
      "combatTrialParticipantLimit",
    ],
  };
  const ENCAMPMENT_BUILDING_HRIDS = Object.freeze({
    skilling: "/guild_buildings/skilling_encampment",
    combat: "/guild_buildings/combat_encampment",
  });
  const ENCAMPMENT_SLOTS_PER_LEVEL_FIELDS = Object.freeze({
    skilling: "skillingTrialSlotsPerLevel",
    combat: "combatTrialSlotsPerLevel",
  });
  const TRIAL_BASE_PARTICIPANTS = Object.freeze({
    skilling: 20,
    combat: 40,
  });
  function positiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  }
  function readTrialCapacityField(detail, fields) {
    for (const field of fields) {
      const value = positiveInteger(detail?.[field]);
      if (value != null) return value;
    }
    return null;
  }
  function guildBuildingLevelDictSnapshot() {
    if (state.guildBuildingLevelDict && Object.keys(state.guildBuildingLevelDict).length) {
      return state.guildBuildingLevelDict;
    }
    const fromGuild = state.guild?.guildBuildingLevelMap ?? state.guild?.guildBuildingLevelDict;
    if (fromGuild && typeof fromGuild === "object" && Object.keys(fromGuild).length) return fromGuild;
    return state.guildBuildingMap;
  }
  function guildBuildingLevel(buildingHrid) {
    const raw = dictionaryValue(guildBuildingLevelDictSnapshot(), buildingHrid);
    if (typeof raw === "number") return positiveInteger(raw);
    const row = object(raw);
    return positiveInteger(row.level ?? row.buildingLevel ?? row.currentLevel);
  }
  function encampmentTrialSlotsBonus(kind) {
    const buildingHrid = ENCAMPMENT_BUILDING_HRIDS[kind];
    const detail = object(dictionaryValue(state.guildBuildingDetailMap, buildingHrid));
    const slotsPerLevel = positiveInteger(detail[ENCAMPMENT_SLOTS_PER_LEVEL_FIELDS[kind]]) ?? 0;
    const maxLevel = positiveInteger(detail.maxLevel);
    const buildingLevel = guildBuildingLevel(buildingHrid) ?? 0;
    const effectiveLevel = maxLevel != null ? Math.min(buildingLevel, maxLevel) : buildingLevel;
    return Math.max(0, effectiveLevel) * slotsPerLevel;
  }
  function encampmentMaxParticipants(kind) {
    const direct = readTrialCapacityField(state.guild, GUILD_TRIAL_CAPACITY_FIELDS[kind]);
    if (direct != null) return direct;
    return TRIAL_BASE_PARTICIPANTS[kind] + encampmentTrialSlotsBonus(kind);
  }
  function trialMaxParticipants(detail, kind) {
    const fromDetail = readTrialCapacityField(detail, TRIAL_CAPACITY_FIELDS);
    if (fromDetail != null) return fromDetail;
    return encampmentMaxParticipants(kind);
  }
  function countTrialSignups(trialHrid, kind) {
    const fromDetail = readTrialCapacityField(
      object(dictionaryValue(state.guildTrialDetailMap, trialHrid)),
      TRIAL_SIGNUP_COUNT_FIELDS,
    );
    if (fromDetail != null) return fromDetail;
    const signupField = kind === "combat"
      ? "signedUpCombatTrialHrid"
      : "signedUpSkillingTrialHrid";
    let count = 0;
    for (const guildCharacter of values(state.guildCharacterMap)) {
      const signedUp = String(guildCharacter?.[signupField] ?? "").trim();
      if (signedUp !== trialHrid || !currentWeekSignup(guildCharacter)) continue;
      count += 1;
    }
    return count > 0 ? count : null;
  }
  function weeklyTrialCatalogPayload() {
    if (!confirmedTmdGuild()) return null;
    const guild = detectedGameGuild();
    const reporterPlayerId = Number(state.character.id ?? state.character.characterId);
    const reporterMemberId = detectedMemberId();
    if (!Number.isInteger(reporterPlayerId) || reporterPlayerId <= 0) return null;
    const skillHrids = [...new Set(values(state.guildWeeklyTrialSet?.skillHrids).map(String).filter(Boolean))];
    const combatHrids = [...new Set(values(state.guildWeeklyTrialSet?.combatHrids).map(String).filter(Boolean))];
    if (!skillHrids.length && !combatHrids.length) return null;
    const trials = [
      ...skillHrids.map((trialHrid) => {
        const detail = object(dictionaryValue(state.guildTrialDetailMap, trialHrid));
        const maxParticipants = trialMaxParticipants(detail, "skilling");
        const signedUpCount = countTrialSignups(trialHrid, "skilling");
        return {
          trialHrid,
          trialName: SKILL_TRIAL_NAMES[trialHrid] ?? String(detail.name ?? trialHrid.split("/").at(-1)),
          kind: "skilling",
          skillHrid: String(detail.skillHrid ?? "").slice(0, 256),
          actionTypeHrid: String(detail.actionTypeHrid ?? "").slice(0, 256),
          ...(maxParticipants != null ? { maxParticipants } : {}),
          ...(signedUpCount != null ? { signedUpCount } : {}),
          monsterHrids: [],
          monsters: [],
        };
      }),
      ...combatHrids.map((trialHrid) => {
        const detail = object(dictionaryValue(state.guildTrialDetailMap, trialHrid));
        const maxParticipants = trialMaxParticipants(detail, "combat");
        const signedUpCount = countTrialSignups(trialHrid, "combat");
        const rawMonsterHrids = detail.monsterHrids ?? detail.monsterHrid
          ?? COMBAT_TRIAL_MONSTERS[trialHrid];
        const monsterHrids = [...new Set((Array.isArray(rawMonsterHrids) ? rawMonsterHrids : rawMonsterHrids ? [rawMonsterHrids] : [])
          .map((value) => String(value?.monsterHrid ?? value?.hrid ?? value))
          .filter((hrid) => hrid.startsWith("/monsters/")))];
        return {
          trialHrid,
          trialName: COMBAT_TRIAL_NAMES[trialHrid] ?? String(detail.name ?? trialHrid.split("/").at(-1)),
          kind: "combat",
          skillHrid: "",
          actionTypeHrid: "",
          ...(maxParticipants != null ? { maxParticipants } : {}),
          ...(signedUpCount != null ? { signedUpCount } : {}),
          monsterHrids,
          monsters: monsterHrids.flatMap((monsterHrid) => {
            const monster = dictionaryValue(state.combatMonsterDetailMap, monsterHrid);
            return monster && typeof monster === "object"
              ? [compactMonsterDetail(monsterHrid, monster)]
              : [];
          }),
        };
      }),
    ];
    return {
      guild: { id: guild.id, name: guild.name },
      reporter: { playerId: reporterPlayerId, memberId: reporterMemberId },
      weekStartAt: currentGuildWeekStart().toISOString(),
      weeklyTrialSet: { skillHrids, combatHrids },
      trials,
      capturedAt: new Date().toISOString(),
    };
  }
  function currentGuildWeekStart() {
    const date = new Date();
    const daysSinceFriday = (date.getUTCDay() + 2) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceFriday);
    date.setUTCHours(0, 0, 0, 0);
    return date;
  }
  function currentWeekSignup(guildCharacter) {
    const value = guildCharacter?.signupWeekStartAt;
    if (value == null || value === "") return true;
    const timestamp = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(timestamp)
      && Math.abs(timestamp - currentGuildWeekStart().getTime()) < 12 * 60 * 60 * 1000;
  }
  function guildTrialRegistrationPayload() {
    if (!confirmedTmdGuild()) return null;
    const guild = detectedGameGuild();
    const sharable = state.guildSharableCharacterMap;
    const signupLevels = state.guildTrialSignupLevelMap;
    const combatRows = [];
    const skillingRows = [];
    for (const [mapKey, guildCharacter] of entries(state.guildCharacterMap)) {
      if (!currentWeekSignup(guildCharacter)) continue;
      const playerId = Number(guildCharacter?.characterID ?? guildCharacter?.characterId ?? mapKey);
      if (!Number.isInteger(playerId) || playerId <= 0) continue;
      const shared = sharable instanceof Map
        ? sharable.get(mapKey) ?? sharable.get(playerId) ?? sharable.get(String(playerId)) ?? {}
        : sharable?.[mapKey] ?? sharable?.[playerId] ?? sharable?.[String(playerId)] ?? {};
      const memberId = String(shared?.name ?? guildCharacter?.name ?? "").trim();
      if (!memberId) continue;
      const levelRow = signupLevels instanceof Map
        ? signupLevels.get(mapKey) ?? signupLevels.get(playerId) ?? signupLevels.get(String(playerId)) ?? {}
        : signupLevels?.[mapKey] ?? signupLevels?.[playerId] ?? signupLevels?.[String(playerId)] ?? {};
      const combatHrid = String(guildCharacter?.signedUpCombatTrialHrid ?? "").trim();
      if (Object.hasOwn(COMBAT_TRIAL_NAMES, combatHrid)) {
        combatRows.push({
          trialHrid: combatHrid,
          playerId,
          memberId,
          roleHrid: String(guildCharacter?.signedUpCombatRoleHrid ?? "").trim(),
          level: Math.max(0, Math.trunc(Number(levelRow?.combatLevel) || 0)),
        });
      }
      const skillingHrid = String(guildCharacter?.signedUpSkillingTrialHrid ?? "").trim();
      if (Object.hasOwn(SKILL_TRIAL_NAMES, skillingHrid)) {
        skillingRows.push({
          trialHrid: skillingHrid,
          playerId,
          memberId,
          roleHrid: "",
          level: Math.max(0, Math.trunc(Number(levelRow?.skillingLevel) || Number(levelRow?.skillLevel) || 0)),
        });
      }
    }
    const combatTrialHrids = [...new Set([
      ...values(state.guildWeeklyTrialSet?.combatHrids).map(String).filter((hrid) => Object.hasOwn(COMBAT_TRIAL_NAMES, hrid)),
      ...combatRows.map((row) => row.trialHrid),
    ])];
    const skillingTrialHrids = [...new Set([
      ...values(state.guildWeeklyTrialSet?.skillHrids).map(String).filter((hrid) => Object.hasOwn(SKILL_TRIAL_NAMES, hrid)),
      ...skillingRows.map((row) => row.trialHrid),
    ])];
    const reporterPlayerId = Number(state.character.id ?? state.character.characterId);
    const reporterMemberId = detectedMemberId();
    if (
      (!combatTrialHrids.length && !skillingTrialHrids.length) ||
      !Number.isInteger(reporterPlayerId) ||
      reporterPlayerId <= 0
    ) {
      return null;
    }
    const buildTrials = (trialHrids, rows, nameMap) => trialHrids.map((trialHrid) => {
      const members = rows
        .filter((row) => row.trialHrid === trialHrid)
        .map(({ trialHrid: _trialHrid, ...member }) => member)
        .sort((left, right) => right.level - left.level || left.memberId.localeCompare(right.memberId));
      return {
        trialHrid,
        trialName: nameMap[trialHrid],
        registeredCount: members.length,
        members,
      };
    });
    return {
      guild: { id: guild.id, name: guild.name },
      reporter: { playerId: reporterPlayerId, memberId: reporterMemberId },
      weekStartAt: currentGuildWeekStart().toISOString(),
      trials: [
        ...buildTrials(combatTrialHrids, combatRows, COMBAT_TRIAL_NAMES),
        ...buildTrials(skillingTrialHrids, skillingRows, SKILL_TRIAL_NAMES),
      ],
      capturedAt: new Date().toISOString(),
    };
  }
  function payload() {
    // Building a snapshot hydrates game state and refreshes the panel. That must
    // not arm another automatic upload, or every sync immediately reschedules
    // itself and loops forever.
    automaticSync.suppressSchedule = true;
    try {
      hydrateFromGameCache();
      hydrateFromLiveGame();
    } finally {
      automaticSync.suppressSchedule = false;
    }
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
      timeout: 30_000,
      onload: resolve,
      ontimeout: () => reject(new Error(tr("syncTimeout"))),
      onerror: () => reject(new Error(tr("syncUnreachable"))),
    }));
  }

  const COMBAT_ABILITY_NAMES_ZH = Object.freeze({
    "/abilities/insanity": "疯狂",
    "/abilities/invincible": "无敌",
    "/abilities/revive": "复活",
    "/abilities/guardian_aura": "守护光环",
    "/abilities/speed_aura": "速度光环",
    "/abilities/fierce_aura": "物理光环",
    "/abilities/critical_aura": "暴击光环",
    "/abilities/mystic_aura": "元素光环",
    "/abilities/elemental_affinity": "元素增幅",
    "/abilities/precision": "精确",
    "/abilities/berserk": "狂暴",
    "/abilities/frenzy": "狂速",
    "/abilities/pestilent_shot": "疫病射击",
    "/abilities/penetrating_shot": "贯穿射击",
    "/abilities/penetrating_strike": "贯心之刺",
    "/abilities/puncture": "破甲之刺",
    "/abilities/maim": "血刃斩",
    "/abilities/crippling_slash": "致残斩",
    "/abilities/fracturing_impact": "碎裂冲击",
    "/abilities/sweep": "重扫",
    "/abilities/stunning_blow": "重锤",
    "/abilities/quick_shot": "快速射击",
    "/abilities/steady_shot": "稳定射击",
    "/abilities/rain_of_arrows": "箭雨",
    "/abilities/water_strike": "流水冲击",
    "/abilities/ice_spear": "冰枪术",
    "/abilities/frost_surge": "冰霜爆裂",
    "/abilities/mana_spring": "法力喷泉",
    "/abilities/entangle": "缠绕",
    "/abilities/toxic_pollen": "剧毒粉尘",
    "/abilities/natures_veil": "自然菌幕",
    "/abilities/life_drain": "生命吸取",
    "/abilities/fireball": "火球",
    "/abilities/flame_blast": "熔岩爆裂",
    "/abilities/firestorm": "火焰风暴",
    "/abilities/smoke_burst": "烟爆灭影",
    "/abilities/rejuvenate": "群体治疗术",
    "/abilities/quick_aid": "快速治疗术",
    "/abilities/taunt": "嘲讽",
    "/abilities/provoke": "挑衅",
    "/abilities/toughness": "坚韧",
    "/abilities/elusiveness": "闪避",
  });
  const COMBAT_ABILITY_NAMES_EN = Object.freeze({
    "/abilities/insanity": "Insanity",
    "/abilities/invincible": "Invincible",
    "/abilities/revive": "Revive",
    "/abilities/guardian_aura": "Guardian Aura",
    "/abilities/speed_aura": "Speed Aura",
    "/abilities/fierce_aura": "Fierce Aura",
    "/abilities/critical_aura": "Critical Aura",
    "/abilities/mystic_aura": "Mystic Aura",
    "/abilities/elemental_affinity": "Elemental Affinity",
    "/abilities/precision": "Precision",
    "/abilities/berserk": "Berserk",
    "/abilities/frenzy": "Frenzy",
    "/abilities/pestilent_shot": "Pestilent Shot",
    "/abilities/penetrating_shot": "Penetrating Shot",
    "/abilities/penetrating_strike": "Penetrating Strike",
    "/abilities/puncture": "Puncture",
    "/abilities/maim": "Maim",
    "/abilities/crippling_slash": "Crippling Slash",
    "/abilities/fracturing_impact": "Fracturing Impact",
    "/abilities/sweep": "Sweep",
    "/abilities/stunning_blow": "Stunning Blow",
    "/abilities/quick_shot": "Quick Shot",
    "/abilities/steady_shot": "Steady Shot",
    "/abilities/rain_of_arrows": "Rain of Arrows",
    "/abilities/water_strike": "Water Strike",
    "/abilities/ice_spear": "Ice Spear",
    "/abilities/frost_surge": "Frost Surge",
    "/abilities/mana_spring": "Mana Spring",
    "/abilities/entangle": "Entangle",
    "/abilities/toxic_pollen": "Toxic Pollen",
    "/abilities/natures_veil": "Nature's Veil",
    "/abilities/life_drain": "Life Drain",
    "/abilities/fireball": "Fireball",
    "/abilities/flame_blast": "Flame Blast",
    "/abilities/firestorm": "Firestorm",
    "/abilities/smoke_burst": "Smoke Burst",
    "/abilities/rejuvenate": "Rejuvenate",
    "/abilities/quick_aid": "Quick Aid",
    "/abilities/taunt": "Taunt",
    "/abilities/provoke": "Provoke",
    "/abilities/toughness": "Toughness",
    "/abilities/elusiveness": "Elusiveness",
  });

  function assignmentInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isInteger(number) ? number : fallback;
  }

  function assignmentName(value) {
    return String(value ?? "").trim().toLocaleLowerCase();
  }

  function combatAbilityName(abilityHrid) {
    const names = lang() === zh ? COMBAT_ABILITY_NAMES_ZH : COMBAT_ABILITY_NAMES_EN;
    if (names[abilityHrid]) return names[abilityHrid];
    return String(abilityHrid || "").split("/").at(-1)?.split("_")
      .filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ") || "未知技能";
  }

  function normalizeAssignmentAbilities(member) {
    const direct = Array.isArray(member?.simulatedAbilities) ? member.simulatedAbilities : [];
    if (direct.length >= 5) {
      return direct.slice(0, 5).map((ability, slot) => ({
        slot,
        abilityHrid: String(ability?.abilityHrid ?? ""),
        level: Math.max(1, assignmentInteger(ability?.level, 1)),
      })).filter((ability) => /^\/abilities\/[a-z0-9_]+$/.test(ability.abilityHrid));
    }
    const abilityHrids = Array.isArray(member?.abilityHrids) ? member.abilityHrids : [];
    const abilityLevels = member?.abilityLevels && typeof member.abilityLevels === "object"
      ? member.abilityLevels : {};
    return abilityHrids.slice(0, 5).map((abilityHrid, slot) => ({
      slot,
      abilityHrid: String(abilityHrid ?? ""),
      level: Math.max(1, assignmentInteger(abilityLevels[abilityHrid], 1)),
    })).filter((ability) => /^\/abilities\/[a-z0-9_]+$/.test(ability.abilityHrid));
  }

  function normalizeLifeAssignment(source) {
    if (!source || typeof source !== "object") throw new Error("invalid life assignment document");
    const generatedAt = Date.parse(String(source.generatedAt ?? ""));
    const currentWeekStart = currentGuildWeekStart().getTime();
    const weekStartAt = Date.parse(String(source.weekStartAt ?? ""));
    if (!Number.isFinite(generatedAt) || generatedAt < currentWeekStart - 12 * 60 * 60 * 1000) {
      throw new Error("life assignment is not from the current guild week");
    }
    if (Number.isFinite(weekStartAt) && weekStartAt < currentWeekStart - 12 * 60 * 60 * 1000) {
      throw new Error("life assignment week is stale");
    }
    const trials = (Array.isArray(source.trials) ? source.trials : []).flatMap((trial) => {
      const trialHrid = String(trial?.trialHrid ?? trial?.hrid ?? trial?.id ?? "").trim();
      if (!trialHrid.startsWith("/guild_skilling/")) return [];
      const roster = Array.isArray(trial?.roster)
        ? trial.roster
        : Array.isArray(trial?.assignments) ? trial.assignments : [];
      const members = roster.flatMap((member) => {
        const memberId = typeof member === "string"
          ? member.trim()
          : String(member?.memberId ?? member?.name ?? member?.characterName ?? "").trim();
        return memberId ? [memberId] : [];
      });
      return [{
        trialHrid,
        trialName: String(trial?.trialName ?? trial?.name ?? SKILL_TRIAL_NAMES[trialHrid] ?? trialHrid.split("/").at(-1)).trim(),
        skillHrid: String(trial?.skillHrid ?? "").trim(),
        members,
      }];
    });
    if (!trials.length) throw new Error("life assignment has no skill trials");
    return {
      generatedAt: new Date(generatedAt).toISOString(),
      weekStartAt: Number.isFinite(weekStartAt) ? new Date(weekStartAt).toISOString() : "",
      trials,
    };
  }

  function lifeAssignmentCardMatches(trial, card) {
    const explicit = card.getAttribute("data-trial-hrid") || card.dataset?.trialHrid || "";
    if (explicit && explicit === trial.trialHrid) return true;
    const trialSlug = trial.trialHrid.split("/").at(-1)?.toLocaleLowerCase() || "";
    const href = card.querySelector("use")?.getAttribute("href") || "";
    const iconKey = href.split("#").at(-1)?.toLocaleLowerCase() || "";
    if (trialSlug && iconKey === trialSlug) return true;
    const text = String(card.textContent || "").toLocaleLowerCase();
    const names = [
      trial.trialName,
      SKILL_TRIAL_NAMES[trial.trialHrid],
      trialSlug.replaceAll("_", " "),
    ].filter(Boolean).map((value) => String(value).toLocaleLowerCase());
    return names.some((name) => name.length >= 2 && text.includes(name));
  }

  function ownGuildCharacterRecord() {
    const characterId = Number(state.character.id ?? state.character.characterId);
    const memberName = assignmentName(detectedMemberId());
    return entries(state.guildCharacterMap).map(([mapKey, guildCharacter]) => {
      const playerId = Number(guildCharacter?.characterID ?? guildCharacter?.characterId ?? mapKey);
      const shared = state.guildSharableCharacterMap instanceof Map
        ? state.guildSharableCharacterMap.get(mapKey)
          ?? state.guildSharableCharacterMap.get(playerId)
          ?? state.guildSharableCharacterMap.get(String(playerId))
          ?? {}
        : state.guildSharableCharacterMap?.[mapKey]
          ?? state.guildSharableCharacterMap?.[playerId]
          ?? state.guildSharableCharacterMap?.[String(playerId)]
          ?? {};
      return {
        guildCharacter,
        memberId: String(shared?.name ?? guildCharacter?.name ?? guildCharacter?.characterName ?? "").trim(),
        playerId,
      };
    }).find((row) => (
      Number.isInteger(characterId) && characterId > 0 && row.playerId === characterId
    ) || (
      memberName && assignmentName(row.memberId) === memberName
    )) || null;
  }

  function currentSkillingTrialHrids() {
    const current = values(state.guildWeeklyTrialSet?.skillHrids)
      .map(String)
      .filter((trialHrid) => Object.hasOwn(SKILL_TRIAL_NAMES, trialHrid));
    return current.length ? current : Object.keys(SKILL_TRIAL_NAMES);
  }

  function currentSkillingSignupHrid(cards = []) {
    const own = ownGuildCharacterRecord();
    const fromState = String(own?.guildCharacter?.signedUpSkillingTrialHrid ?? "").trim();
    if (fromState && currentWeekSignup(own.guildCharacter)) return fromState;
    const nativeCard = cards.find((card) => (
      String(card.className).includes("trialTileMine")
      && currentSkillingTrialHrids().some((trialHrid) => lifeAssignmentCardMatches({ trialHrid }, card))
    ));
    return currentSkillingTrialHrids().find((trialHrid) => nativeCard && lifeAssignmentCardMatches({ trialHrid }, nativeCard)) || "";
  }

  function lifeTrialName(trialHrid, fallback = "") {
    return lang() === zh
      ? (SKILL_TRIAL_NAMES[trialHrid] || fallback || trialHrid)
      : (fallback || trialHrid.split("/").at(-1)?.replaceAll("_", " ") || trialHrid);
  }

  function combatAbilityIconUrl(abilityHrid) {
    const slug = String(abilityHrid || "").split("/").at(-1) || "";
    return `${COMBAT_ABILITY_ICON_BASE}/${encodeURIComponent(slug)}.png`;
  }

  function normalizeCombatAssignment(source) {
    if (!source || typeof source !== "object") throw new Error("invalid assignment document");
    const generatedAt = Date.parse(String(source.generatedAt ?? ""));
    const currentWeekStart = currentGuildWeekStart().getTime();
    if (!Number.isFinite(generatedAt) || generatedAt < currentWeekStart - 12 * 60 * 60 * 1000) {
      throw new Error("assignment is not from the current guild week");
    }
    const rawBosses = Array.isArray(source.bosses)
      ? source.bosses
      : Array.isArray(source.combatTrials) ? source.combatTrials : [];
    const bosses = rawBosses.flatMap((boss, index) => {
      const trialHrid = String(boss?.bossId ?? boss?.trialHrid ?? boss?.id ?? "").trim();
      if (!trialHrid.startsWith("/guild_combat/")) return [];
      const bossKey = String(boss?.bossKey ?? trialHrid.split("/").at(-1) ?? index).trim();
      const members = Array.isArray(boss?.roster)
        ? boss.roster
        : Array.isArray(boss?.members) ? boss.members : [];
      return [{
        trialHrid,
        bossKey,
        bossName: String(boss?.bossName ?? boss?.trialName ?? boss?.name ?? displayCombatTrialName(trialHrid)).trim(),
        members: members.flatMap((member) => {
          const memberId = String(member?.memberId ?? member?.name ?? member?.characterName ?? "").trim();
          if (!memberId) return [];
          return [{
            memberId,
            abilities: normalizeAssignmentAbilities(member),
            combatType: String(member?.combatType ?? "").trim(),
            duty: String(member?.duty ?? member?.role ?? "").trim(),
            auraHrid: String(member?.auraHrid ?? "").trim(),
          }];
        }),
      }];
    });
    if (!bosses.length) throw new Error("assignment has no combat rosters");
    return {
      generatedAt: new Date(generatedAt).toISOString(),
      bosses,
    };
  }

  function combatAssignmentCardSignature(cards) {
    return cards.map((card) => {
      const name = card.querySelector("[class*=tileName]")?.textContent?.trim() || "";
      const icon = card.querySelector("use")?.getAttribute("href") || "";
      return `${name}|${icon}`;
    }).join(";");
  }

  function combatAssignmentCardMatches(boss, card) {
    const explicit = card.getAttribute("data-trial-hrid") || card.dataset?.trialHrid || "";
    if (explicit && explicit === boss.trialHrid) return true;
    const href = card.querySelector("use")?.getAttribute("href") || "";
    const iconKey = href.split("#").at(-1)?.replace(/^trial_/, "").toLocaleLowerCase() || "";
    if (iconKey && iconKey === boss.bossKey.toLocaleLowerCase()) return true;
    const text = String(card.textContent || "").toLocaleLowerCase();
    const names = [
      boss.bossName,
      COMBAT_TRIAL_NAMES[boss.trialHrid],
      COMBAT_TRIAL_NAMES_EN[boss.trialHrid],
      boss.bossKey.replaceAll("_", " "),
    ].filter(Boolean).map((value) => String(value).toLocaleLowerCase());
    return names.some((name) => name.length >= 2 && text.includes(name));
  }

  function injectCombatAssignmentStyle() {
    const style = document.getElementById("adudu-guild-sync-assignment-style") || document.createElement("style");
    style.id = "adudu-guild-sync-assignment-style";
    style.textContent = `
      [data-adudu-guild-assignment="combat"]{position:relative;z-index:2;outline:3px solid #ffd60a!important;outline-offset:-3px;box-shadow:inset 0 0 0 2px #fff3a0,0 0 0 2px #ffd60a,0 0 22px #ffd60a88!important}
      [data-adudu-guild-assignment="life"]{position:relative;z-index:2;outline:3px solid #30d158!important;outline-offset:-3px;box-shadow:inset 0 0 0 2px #b6ffc5,0 0 0 2px #30d158,0 0 22px #30d15888!important}
      [data-adudu-guild-assignment="life-mismatch"]{position:relative;z-index:2;outline:3px solid #ff453a!important;outline-offset:-3px;box-shadow:inset 0 0 0 2px #ffb8b2,0 0 0 2px #ff453a,0 0 22px #ff453a88!important}
      .adudu-guild-sync-assignment-badge{position:absolute;z-index:4;right:6px;top:6px;padding:3px 7px;border-radius:999px;background:#0a84ff;color:#fff;font:700 11px/1.2 system-ui,sans-serif;box-shadow:0 2px 8px #0008;pointer-events:none;white-space:nowrap}
      .adudu-guild-sync-assignment-badge[data-kind="life"]{background:#30a14e}
      .adudu-guild-sync-assignment-badge[data-kind="life-mismatch"]{background:#d70015}
      .adudu-guild-sync-skill-panel{width:100%;box-sizing:border-box;margin:14px 0 4px;padding:12px 14px;border:1px solid #ff5a6499;border-left:4px solid #ff453a;border-radius:10px;background:linear-gradient(105deg,#25181dd9,#171a24e8);color:#f5f7ff;box-shadow:0 8px 20px #0005;font:600 12px/1.3 system-ui,sans-serif}
      .adudu-guild-sync-skill-panel-heading{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:9px}
      .adudu-guild-sync-skill-panel-heading strong{color:#ff737b;font-size:16px}
      .adudu-guild-sync-skill-panel-heading span{color:#c9cedd;font-size:11px}
      .adudu-guild-sync-skill-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px}
      .adudu-guild-sync-skill-chip{display:flex;min-width:0;flex-direction:column;align-items:center;gap:2px;padding:7px 3px;border:1px solid #59647d;border-radius:7px;background:#252b3a;color:#f5f7ff;text-align:center}
      .adudu-guild-sync-skill-icon{width:34px;height:34px;object-fit:contain;display:block;flex:0 0 34px}
      .adudu-guild-sync-skill-chip[data-required-aura="true"]{border:2px solid #ff453a;background:#4a1f25;color:#fff0f0;box-shadow:0 0 9px #ff453a99}
      .adudu-guild-sync-skill-chip small{color:#c9d4ff;font-size:10px}
      .adudu-guild-sync-skill-required{color:#ff8f8f;font-size:9px}
      .adudu-guild-sync-life-warning{width:100%;box-sizing:border-box;margin:10px 0 4px;padding:10px 14px;border:2px solid #ff453a;border-radius:10px;background:#421d22e8;color:#fff0f0;box-shadow:0 6px 16px #0005;font:700 13px/1.4 system-ui,sans-serif}
      .adudu-guild-sync-life-warning strong{display:block;color:#ff817a;font-size:15px;margin-bottom:3px}
      .adudu-guild-sync-life-warning span{display:block;color:#ffe7e5}
      @media (max-width:760px){.adudu-guild-sync-assignment-badge{top:3px;right:3px;font-size:9px}.adudu-guild-sync-skill-panel{padding:9px 7px}.adudu-guild-sync-skill-panel-heading{align-items:flex-start;flex-direction:column;gap:2px}.adudu-guild-sync-skill-panel-heading strong{font-size:14px}.adudu-guild-sync-skill-grid{gap:3px}.adudu-guild-sync-skill-chip{padding:5px 2px;font-size:10px}.adudu-guild-sync-skill-chip small{font-size:8px}.adudu-guild-sync-skill-icon{width:28px;height:28px;flex-basis:28px}}
    `;
    document.head?.appendChild(style);
  }

  function clearCombatAssignmentUi() {
    clearCombatAssignmentOnly();
    clearLifeAssignmentUi();
  }

  function clearCombatAssignmentOnly() {
    document.querySelectorAll('[data-adudu-guild-assignment="combat"]').forEach((node) => delete node.dataset.aduduGuildAssignment);
    document.querySelectorAll('.adudu-guild-sync-assignment-badge[data-kind="combat"],.adudu-guild-sync-skill-panel').forEach((node) => node.remove());
  }

  function clearLifeAssignmentUi() {
    document.querySelectorAll('[data-adudu-guild-assignment="life"],[data-adudu-guild-assignment="life-mismatch"]').forEach((node) => delete node.dataset.aduduGuildAssignment);
    document.querySelectorAll("[data-adudu-guild-signup-mismatch]").forEach((node) => delete node.dataset.aduduGuildSignupMismatch);
    document.querySelectorAll('.adudu-guild-sync-assignment-badge[data-kind="life"],.adudu-guild-sync-assignment-badge[data-kind="life-mismatch"],.adudu-guild-sync-life-warning').forEach((node) => node.remove());
    lifeAssignmentState.mismatch = null;
  }

  function renderCombatAssignmentCard(card, boss, member) {
    card.dataset.aduduGuildAssignment = "combat";
    card.title = `${boss.bossName}：${tr("你的本周战斗分工", "Your weekly combat assignment")}`;
    card.querySelectorAll(".adudu-guild-sync-assignment-badge").forEach((node) => node.remove());
    const badge = document.createElement("span");
    badge.className = "adudu-guild-sync-assignment-badge";
    badge.dataset.kind = "combat";
    badge.textContent = tr("你的分工", "Your assignment");
    card.appendChild(badge);
  }

  function renderCombatAssignmentSkillPanel(entry, cards) {
    const { boss, member, card } = entry;
    const anchor = card?.parentElement;
    const host = anchor?.parentElement;
    if (!host) return false;
    const panel = document.createElement("section");
    panel.className = "adudu-guild-sync-skill-panel";
    panel.setAttribute("aria-label", tr("应该携带的战斗技能", "Combat abilities to equip"));
    const heading = document.createElement("div");
    heading.className = "adudu-guild-sync-skill-panel-heading";
    const title = document.createElement("strong");
    title.textContent = tr("本周战斗技能", "Weekly combat abilities");
    const trial = document.createElement("span");
    trial.textContent = `${boss.bossName} · ${tr("按从左到右顺序携带", "equip from left to right")}`;
    heading.append(title, trial);
    const grid = document.createElement("div");
    grid.className = "adudu-guild-sync-skill-grid";
    const auraRequired = Boolean(member.auraHrid)
      || /^\/abilities\/[a-z0-9_]+_aura$/.test(member.abilities[0]?.abilityHrid || "");
    for (const ability of member.abilities) {
      const chip = document.createElement("span");
      chip.className = "adudu-guild-sync-skill-chip";
      const required = auraRequired && ability.slot === 0;
      if (required) chip.dataset.requiredAura = "true";
      const icon = document.createElement("img");
      icon.className = "adudu-guild-sync-skill-icon";
      icon.src = combatAbilityIconUrl(ability.abilityHrid);
      icon.alt = combatAbilityName(ability.abilityHrid);
      icon.loading = "eager";
      icon.decoding = "async";
      icon.addEventListener("error", () => { icon.hidden = true; });
      chip.appendChild(icon);
      const label = document.createElement("span");
      label.textContent = `${ability.slot + 1}. ${combatAbilityName(ability.abilityHrid)}`;
      chip.appendChild(label);
      const level = document.createElement("small");
      level.textContent = `Lv.${ability.level}`;
      chip.appendChild(level);
      if (required) {
        const must = document.createElement("span");
        must.className = "adudu-guild-sync-skill-required";
        must.textContent = tr("必带", "Must");
        chip.appendChild(must);
      }
      grid.appendChild(chip);
    }
    panel.append(heading, grid);
    host.insertAdjacentElement("afterend", panel);
    return true;
  }

  function renderLifeAssignmentCard(card, trial, kind = "life") {
    card.dataset.aduduGuildAssignment = kind;
    card.title = lang() === zh
      ? `${trial.trialName}：${kind === "life" ? "你的本周生活分工" : "当前报名错误"}`
      : `${trial.trialName}: ${kind === "life" ? "Your weekly life assignment" : "Wrong current signup"}`;
    card.querySelectorAll(".adudu-guild-sync-assignment-badge").forEach((node) => node.remove());
    const badge = document.createElement("span");
    badge.className = "adudu-guild-sync-assignment-badge";
    badge.dataset.kind = kind;
    badge.textContent = tr(kind === "life" ? "lifeExpectedBadge" : "lifeMismatchBadge");
    card.appendChild(badge);
  }

  function renderLifeAssignmentWarning(expected, actual, anchorCard) {
    const anchor = anchorCard?.parentElement;
    const host = anchor?.parentElement;
    if (!host || !anchor) return false;
    const warning = document.createElement("section");
    warning.className = "adudu-guild-sync-life-warning";
    warning.setAttribute("role", "alert");
    const title = document.createElement("strong");
    title.textContent = tr("生活试炼报名提醒", "Life trial signup warning");
    const detail = document.createElement("span");
    detail.textContent = lang() === zh
      ? actual
        ? `当前报名：${lifeTrialName(actual.trialHrid, actual.trialName)}；应报名：${lifeTrialName(expected.trialHrid, expected.trialName)}`
        : `当前未报名；应报名：${lifeTrialName(expected.trialHrid, expected.trialName)}`
      : actual
        ? `Current signup: ${lifeTrialName(actual.trialHrid, actual.trialName)}; should join: ${lifeTrialName(expected.trialHrid, expected.trialName)}`
        : `No current signup; you should join: ${lifeTrialName(expected.trialHrid, expected.trialName)}`;
    warning.append(title, detail);
    anchor.insertAdjacentElement("afterend", warning);
    return true;
  }

  function renderLifeAssignmentUi() {
    if (!document.body) return;
    injectCombatAssignmentStyle();
    const cards = [...document.querySelectorAll(COMBAT_TRIAL_CARD_SELECTOR)];
    clearLifeAssignmentUi();
    const trials = lifeAssignmentState.document?.trials || [];
    const memberName = assignmentName(detectedMemberId());
    const expected = trials.find((trial) => trial.members.some((memberId) => assignmentName(memberId) === memberName));
    if (!expected) {
      if (cards.length) setStatus(tr("lifeAssignmentNotAssigned"), true);
      return;
    }
    const expectedCard = cards.find((card) => lifeAssignmentCardMatches(expected, card));
    if (expectedCard) renderLifeAssignmentCard(expectedCard, expected, "life");
    const actualHrid = currentSkillingSignupHrid(cards);
    const actual = actualHrid && (
      trials.find((trial) => trial.trialHrid === actualHrid)
      || { trialHrid: actualHrid, trialName: SKILL_TRIAL_NAMES[actualHrid] || actualHrid }
    );
    const mismatch = actualHrid !== expected.trialHrid;
    lifeAssignmentState.mismatch = mismatch ? { expected, actual: actual || null } : null;
    if (mismatch && actual) {
      const actualCard = cards.find((card) => lifeAssignmentCardMatches(actual, card));
      if (actualCard && actualCard !== expectedCard) renderLifeAssignmentCard(actualCard, actual, "life-mismatch");
      if (actualCard) actualCard.dataset.aduduGuildSignupMismatch = "true";
    }
    if (!expectedCard) {
      setStatus(tr("lifeAssignmentCardsNotFound"), true);
      return;
    }
    if (mismatch) {
      renderLifeAssignmentWarning(expected, actual || null, expectedCard);
      setStatus(actual ? tr("lifeSignupMismatch", lifeTrialName(actual.trialHrid, actual.trialName), lifeTrialName(expected.trialHrid, expected.trialName)) : tr("lifeSignupMissing", lifeTrialName(expected.trialHrid, expected.trialName)), true);
    } else {
      setStatus(tr("lifeSignupOk", lifeTrialName(expected.trialHrid, expected.trialName)));
    }
  }

  function renderCombatAssignmentUi() {
    if (!document.body) return;
    injectCombatAssignmentStyle();
    const cards = [...document.querySelectorAll(COMBAT_TRIAL_CARD_SELECTOR)];
    const signature = combatAssignmentCardSignature(cards);
    combatAssignmentState.lastCardSignature = signature;
    combatAssignmentState.rendering = true;
    try {
      clearCombatAssignmentOnly();
      const bosses = combatAssignmentState.document?.bosses || [];
      const own = bosses.flatMap((boss) => boss.members
        .filter((member) => assignmentName(member.memberId) === assignmentName(detectedMemberId()))
        .map((member) => ({ boss, member })));
      if (!own.length) {
        if (cards.length) setStatus(tr("assignmentNotAssigned"), true);
        return;
      }
      const highlighted = own.map(({ boss, member }) => {
        const card = cards.find((candidate) => combatAssignmentCardMatches(boss, candidate));
        if (card) renderCombatAssignmentCard(card, boss, member);
        return { boss, member, card };
      });
      const first = highlighted.find((entry) => entry.card) || highlighted[0];
      if (!first.card) {
        setStatus(tr("assignmentCardsNotFound"), true);
        return;
      }
      renderCombatAssignmentSkillPanel(first, cards);
      const skills = first.member.abilities.map((ability) => combatAbilityName(ability.abilityHrid)).join("、");
      if (lifeAssignmentState.mismatch) return;
      setStatus(tr("assignmentLoaded", first.boss.bossName, skills));
    } finally {
      combatAssignmentState.rendering = false;
    }
  }

  function scheduleLifeAssignmentRefresh(delay = 0) {
    clearTimeout(lifeAssignmentState.timer);
    const memberId = detectedMemberId();
    if (!memberId) return;
    if (
      lifeAssignmentState.document
      && lifeAssignmentState.lastMemberId === memberId
      && Date.now() - lifeAssignmentState.fetchedAt < COMBAT_ASSIGNMENT_CACHE_MS
    ) {
      if (document.querySelector(COMBAT_TRIAL_CARD_SELECTOR)) renderLifeAssignmentUi();
      return;
    }
    lifeAssignmentState.timer = setTimeout(() => void refreshLifeAssignment(), delay);
  }

  async function refreshLifeAssignment({ force = false } = {}) {
    const memberId = detectedMemberId();
    if (!memberId || !confirmedTmdGuild() || lifeAssignmentState.inFlight) return;
    const cards = [...document.querySelectorAll(COMBAT_TRIAL_CARD_SELECTOR)];
    if (!force
      && lifeAssignmentState.document
      && lifeAssignmentState.lastMemberId === memberId
      && Date.now() - lifeAssignmentState.fetchedAt < COMBAT_ASSIGNMENT_CACHE_MS) {
      if (cards.length) renderLifeAssignmentUi();
      return;
    }
    lifeAssignmentState.inFlight = true;
    lifeAssignmentState.lastMemberId = memberId;
    if (!lifeAssignmentState.document) setStatus(tr("lifeAssignmentLoading"));
    try {
      const response = await requestJson({ method: "GET", url: LIFE_ASSIGNMENT_JSON_URL });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const source = JSON.parse(response.responseText || "{}");
      lifeAssignmentState.document = normalizeLifeAssignment(source);
      lifeAssignmentState.fetchedAt = Date.now();
      renderLifeAssignmentUi();
    } catch (error) {
      lifeAssignmentState.document = null;
      lifeAssignmentState.fetchedAt = 0;
      lifeAssignmentState.mismatch = null;
      clearLifeAssignmentUi();
      if (cards.length) setStatus(tr("lifeAssignmentUnavailable"), true);
      console.warn("[TMD-guild-trial-sync] latest life assignment unavailable", error?.message || error);
    } finally {
      lifeAssignmentState.inFlight = false;
    }
  }

  function scheduleCombatAssignmentRefresh(delay = 0) {
    clearTimeout(combatAssignmentState.timer);
    if (!detectedMemberId()) return;
    if (
      combatAssignmentState.document
      && combatAssignmentState.lastMemberId === detectedMemberId()
      && Date.now() - combatAssignmentState.fetchedAt < COMBAT_ASSIGNMENT_CACHE_MS
    ) {
      if (document.querySelector(COMBAT_TRIAL_CARD_SELECTOR)) renderCombatAssignmentUi();
      return;
    }
    combatAssignmentState.timer = setTimeout(() => void refreshCombatAssignment(), delay);
  }

  async function refreshCombatAssignment({ force = false } = {}) {
    const memberId = detectedMemberId();
    if (!memberId || !confirmedTmdGuild() || combatAssignmentState.inFlight) return;
    const cards = [...document.querySelectorAll(COMBAT_TRIAL_CARD_SELECTOR)];
    if (!force
      && combatAssignmentState.document
      && combatAssignmentState.lastMemberId === memberId
      && Date.now() - combatAssignmentState.fetchedAt < COMBAT_ASSIGNMENT_CACHE_MS) {
      if (cards.length) renderCombatAssignmentUi();
      return;
    }
    combatAssignmentState.inFlight = true;
    combatAssignmentState.lastMemberId = memberId;
    if (!combatAssignmentState.document) setStatus(tr("assignmentLoading"));
    try {
      const response = await requestJson({ method: "GET", url: COMBAT_ASSIGNMENT_JSON_URL });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const source = JSON.parse(response.responseText || "{}");
      combatAssignmentState.document = normalizeCombatAssignment(source);
      combatAssignmentState.fetchedAt = Date.now();
      renderCombatAssignmentUi();
    } catch (error) {
      combatAssignmentState.document = null;
      combatAssignmentState.fetchedAt = 0;
      clearCombatAssignmentOnly();
      if (cards.length) setStatus(tr("assignmentUnavailable"), true);
      console.warn("[TMD-guild-trial-sync] latest combat assignment unavailable", error?.message || error);
    } finally {
      combatAssignmentState.inFlight = false;
    }
  }

  function installCombatAssignmentObserver() {
    if (combatAssignmentState.observer || !document.body) return;
    combatAssignmentState.observer = new MutationObserver(() => {
      if (combatAssignmentState.rendering) return;
      clearTimeout(combatAssignmentState.domTimer);
      combatAssignmentState.domTimer = setTimeout(() => {
        const cards = [...document.querySelectorAll(COMBAT_TRIAL_CARD_SELECTOR)];
        const signature = combatAssignmentCardSignature(cards);
        const cardsChanged = signature !== combatAssignmentState.lastCardSignature;
        if (combatAssignmentState.document && cardsChanged) {
          renderCombatAssignmentUi();
        }
        if (lifeAssignmentState.document && cardsChanged) {
          renderLifeAssignmentUi();
        }
        combatAssignmentState.lastCardSignature = signature;
        if (!combatAssignmentState.document && !lifeAssignmentState.document && cards.length) {
          scheduleCombatAssignmentRefresh();
          scheduleLifeAssignmentRefresh();
        }
      }, 80);
    });
    combatAssignmentState.observer.observe(document.body, { childList: true, subtree: true });
  }

  async function upload({ automatic = false } = {}) {
    if (automaticSync.running) {
      if (automatic) scheduleAutomaticUpload(800);
      return;
    }
    clearTimeout(automaticSync.timer);
    automaticSync.timer = 0;
    const snapshot = payload();
    if (!snapshot.memberId || snapshot.memberId === "unknown-member") {
      setStatus(tr("waitingName"), true);
      return;
    }
    if (!confirmedTmdGuild()) {
      setStatus(tr("notTmdYet"), true);
      const ok = await ensureTmdGuildConfirmed();
      if (!ok) {
        setStatus(tr("notTmdDetail", tmdConfirmDetail()), true);
        return;
      }
    }
    if (snapshot.loadoutCatalog.length > 0
      && snapshot.loadoutCatalog.every((loadout) => loadout.equipment.length === 0)) {
      window.postMessage({ source: PAGE_BRIDGE_CHANNEL, type: "request" }, location.origin);
      automaticSync.suppressSchedule = true;
      try {
        hydrateFromGameCache();
        hydrateFromLiveGame();
      } finally {
        automaticSync.suppressSchedule = false;
      }
      if (automatic) {
        setStatus(tr("waitingEquipmentAuto"));
        scheduleAutomaticUpload(1500);
        return;
      }
      setStatus(tr("waitingEquipmentManual"), true);
      return;
    }
    const roster = guildRosterPayload();
    const trialRegistrations = guildTrialRegistrationPayload();
    const weeklyTrials = weeklyTrialCatalogPayload();
    const signature = JSON.stringify({
      memberId: snapshot.memberId,
      loadoutCatalog: snapshot.loadoutCatalog,
      skills: snapshot.skills,
      learnedAbilities: snapshot.learnedAbilities,
      auras: snapshot.auras,
      roster: roster?.members,
      trials: trialRegistrations?.trials,
      weeklyTrials: weeklyTrials && {
        weeklyTrialSet: weeklyTrials.weeklyTrialSet,
        trials: weeklyTrials.trials,
      },
    });
    if (automatic && signature === automaticSync.lastSignature) return;
    automaticSync.running = true;
    try {
      setStatus(tr("checkingEligibility", snapshot.memberId));
      const eligibility = await requestJson({
        method: "GET",
        url: `${DEFAULT_API_BASE}/api/public/guilds/${FIXED_GUILD_ID}/members/${encodeURIComponent(snapshot.memberId)}/eligibility`,
      });
      const eligibilityBody = JSON.parse(eligibility.responseText || "{}");
      if (eligibility.status !== 200 || eligibilityBody.eligible !== true) {
        setStatus(tr("notEligible", snapshot.memberId), true);
        return;
      }
      let rosterSummary = "";
      if (eligibilityBody.rosterSyncAllowed === true && roster) {
        setStatus(tr("syncingRoster", roster.members.length));
        const rosterResponse = await requestJson({
          method: "POST",
          url: `${DEFAULT_API_BASE}/api/public/guilds/${FIXED_GUILD_ID}/roster`,
          data: roster,
        });
        if (rosterResponse.status >= 200 && rosterResponse.status < 300) {
          rosterSummary = tr("rosterOk", roster.members.length);
        } else if (rosterResponse.status !== 429) {
          let rosterDetail = `HTTP ${rosterResponse.status}`;
          try { rosterDetail = JSON.parse(rosterResponse.responseText)?.error?.message ?? rosterDetail; } catch { /* keep status */ }
          rosterSummary = tr("rosterFailed", rosterDetail);
        }
      }
      let trialSummary = "";
      let weeklyTrialSummary = "";
      const weeklyMonsterPanelsComplete = weeklyTrials?.trials
        ?.filter((trial) => trial.kind === "combat")
        .every((trial) => trial.monsterHrids.length > 0 && trial.monsters.length === trial.monsterHrids.length);
      if (eligibilityBody.rosterSyncAllowed === true && weeklyTrials && weeklyMonsterPanelsComplete) {
        setStatus(tr("syncingWeeklyTrials"));
        const weeklyTrialResponse = await requestJson({
          method: "POST",
          url: `${DEFAULT_API_BASE}/api/public/guilds/${FIXED_GUILD_ID}/weekly-trials`,
          data: weeklyTrials,
        });
        if (weeklyTrialResponse.status >= 200 && weeklyTrialResponse.status < 300) {
          weeklyTrialSummary = tr(
            "weeklyTrialsOk",
            weeklyTrials.weeklyTrialSet.skillHrids.length,
            weeklyTrials.weeklyTrialSet.combatHrids.length,
          );
        } else if (weeklyTrialResponse.status !== 429) {
          let weeklyTrialDetail = `HTTP ${weeklyTrialResponse.status}`;
          try {
            const error = JSON.parse(weeklyTrialResponse.responseText)?.error;
            weeklyTrialDetail = error?.code === "incomplete_weekly_monsters"
              ? tr("monstersIncomplete")
              : error?.message ?? weeklyTrialDetail;
          } catch { /* keep status */ }
          weeklyTrialSummary = tr("weeklyTrialsFailed", weeklyTrialDetail);
        }
      } else if (eligibilityBody.rosterSyncAllowed === true && weeklyTrials) {
        weeklyTrialSummary = tr("waitingMonsters");
      }
      if (eligibilityBody.rosterSyncAllowed === true && trialRegistrations) {
        setStatus(tr("syncingSignups"));
        const trialResponse = await requestJson({
          method: "POST",
          url: `${DEFAULT_API_BASE}/api/public/guilds/${FIXED_GUILD_ID}/trial-registrations`,
          data: trialRegistrations,
        });
        if (trialResponse.status >= 200 && trialResponse.status < 300) {
          trialSummary = tr(
            "signupsOk",
            trialRegistrations.trials
              .map((trial) => `${displayCombatTrialName(trial.trialHrid)} ${trial.registeredCount}`)
              .join(" / "),
          );
        } else if (trialResponse.status !== 429) {
          let trialDetail = `HTTP ${trialResponse.status}`;
          try { trialDetail = JSON.parse(trialResponse.responseText)?.error?.message ?? trialDetail; } catch { /* keep status */ }
          trialSummary = tr("signupsFailed", trialDetail);
        }
      }
      setStatus(tr("syncingLoadouts"));
      const response = await requestJson({
        method: "POST",
        url: `${DEFAULT_API_BASE}/api/public/guilds/${FIXED_GUILD_ID}/members/${encodeURIComponent(snapshot.memberId)}/snapshots`,
        data: snapshot,
      });
      if (response.status < 200 || response.status >= 300) {
        let detail = `HTTP ${response.status}`;
        try {
          const apiError = JSON.parse(response.responseText)?.error;
          detail = apiError?.code === "empty_loadout_catalog"
            ? tr("waitingEquipmentManual")
            : apiError?.message ?? detail;
        } catch { /* keep status */ }
        throw new Error(detail);
      }
      automaticSync.lastSignature = signature;
      setStatus(tr(
        "synced",
        `${rosterSummary}${weeklyTrialSummary}${trialSummary}`,
        snapshot.loadoutCatalog.length,
        snapshot.memberId,
      ));
    } catch (error) {
      setStatus(tr("syncFailed", error.message), true);
    } finally {
      automaticSync.running = false;
    }
  }
  function scheduleAutomaticUpload(delay = 800) {
    if (automaticSync.suppressSchedule) return;
    clearTimeout(automaticSync.timer);
    automaticSync.timer = setTimeout(() => upload({ automatic: true }), delay);
  }
  function refresh() {
    const list = document.getElementById(UI.list);
    if (!list) return;
    list.replaceChildren(...state.loadouts.map((loadout, index) => {
      const actionTypeHrid = String(loadout.actionTypeHrid ?? loadout.action_type_hrid ?? "");
      const category = actionTypeHrid === "/action_types/combat"
        ? tr("categoryCombat")
        : !actionTypeHrid || actionTypeHrid === "/action_types/all"
          ? tr("categoryAll")
          : actionTypeHrid.startsWith("/action_types/")
            ? tr("categorySkilling")
            : tr("categoryUnknown");
      const gearCount = expandedLoadoutEquipment(loadout).filter((item) => item?.itemHrid || item?.hrid).length;
      const label = document.createElement("label");
      label.append(` [${category}] ${loadout.name ?? `Loadout ${index + 1}`} (${gearCount})`);
      return label;
    }));
    if (hasCharacterData()) scheduleAutomaticUpload();
    if (detectedMemberId()) scheduleCombatAssignmentRefresh(250);
    if (detectedMemberId()) scheduleLifeAssignmentRefresh(350);
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
    panel.setAttribute("aria-label", tr("ariaLabel"));
    panel.style.cssText = [
      "position:fixed", "right:14px", "bottom:14px", "z-index:2147483647",
      "width:min(290px,calc(100vw - 28px))", "padding:12px",
      "background:linear-gradient(145deg,#151d34,#202d50)", "color:#f7f9ff",
      "border:1px solid #7f96dd", "border-radius:10px",
      "box-shadow:0 10px 28px #05091688", "font:13px/1.4 system-ui,sans-serif",
    ].join(";");

    const content = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = tr("heading");
    const intro = document.createElement("p");
    intro.style.margin = "6px 0";
    intro.textContent = tr("intro");
    const list = document.createElement("div");
    list.id = UI.list;
    const status = document.createElement("p");
    status.id = UI.status;
    status.style.cssText = "margin:7px 0;color:#c9d4ff";
    status.textContent = tr("waitingCharacter");
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:5px;flex-wrap:wrap";
    actions.append(
      actionButton(tr("syncNow"), () => upload()),
      actionButton(tr("exportBackup"), download),
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
      toggle.title = collapsed ? tr("expand") : tr("collapse");
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
    installCombatAssignmentObserver();
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
    combatAssignmentState.pollTimer = setInterval(() => {
      if (!document.querySelector(COMBAT_TRIAL_CARD_SELECTOR)) return;
      if (combatAssignmentState.document && Date.now() - combatAssignmentState.fetchedAt < COMBAT_ASSIGNMENT_CACHE_MS) {
        renderCombatAssignmentUi();
      } else {
        scheduleCombatAssignmentRefresh();
      }
      if (lifeAssignmentState.document && Date.now() - lifeAssignmentState.fetchedAt < COMBAT_ASSIGNMENT_CACHE_MS) {
        renderLifeAssignmentUi();
      } else {
        scheduleLifeAssignmentRefresh();
      }
    }, COMBAT_ASSIGNMENT_POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !hasCharacterData()) requestCharacterData();
      if (document.visibilityState === "visible") scheduleCombatAssignmentRefresh(100);
      if (document.visibilityState === "visible") scheduleLifeAssignmentRefresh(150);
    });
  }
  installDirectMessageObserver();
  if (document.documentElement) {
    installPageBridge();
  } else {
    const bridgeObserver = new MutationObserver(() => {
      if (!document.documentElement) return;
      bridgeObserver.disconnect();
      installPageBridge();
    });
    bridgeObserver.observe(document, { childList: true });
  }
  document.addEventListener("DOMContentLoaded", mount, { once: true });
  if (document.readyState !== "loading") mount();
})();
