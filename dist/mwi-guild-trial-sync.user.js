// ==UserScript==
// @name         MWI 公会试炼资料同步助手
// @name:en      TMD-guild-trial-sync
// @namespace    https://greasyfork.org/users/1466859-adudu
// @version      0.6.32
// @description  MWI 公会通用（TMD / Wandering ICarus）：自动同步成员名单、本周试炼、怪物面板、全部配装、技能与光环，并高亮最新战斗分工。
// @description:en  MWI guild sync for TMD and Wandering ICarus: roster, weekly trials, monster panels, loadouts, abilities, auras, and the latest combat assignment.
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
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @connect      mwi.adudu.lol
// @connect      api.adudu.lol
// @run-at       document-start
// ==/UserScript==

/*
 * Independent MIT-licensed implementation by adudu.
 *
 * Data boundary:
 * - reads only the character, guild roster, equipment, loadout, ability and
 *   permanent house/achievement/shrine records required by the guild tools;
 * - one script serves every registered guild; the live game guild name or id
 *   selects the API slug (369 -> TMD, 667 -> WI) with no build-time pinning;
 * - checks the detected character against the guild roster before automatic sync;
 * - never includes cookies, login/session credentials or authorization data in
 *   the snapshot.
 */
(function aduduGuildTrialSync() {
  "use strict";
  const pageContext = typeof unsafeWindow === "object" ? unsafeWindow : window;
  if (pageContext.__ADUDU_GUILD_TRIAL_BRIDGE__) return;
  const MAX_COMBAT_CANDIDATES = 4;
  // One script serves every registered guild. The live game guild decides the
  // API slug, so no build-time identity is baked in.
  const GUILD_REGISTRY = Object.freeze([
    Object.freeze({ apiSlug: "TMD", gameGuildName: "TMD", gameGuildId: 369 }),
    Object.freeze({ apiSlug: "WI", gameGuildName: "Wandering ICarus", gameGuildId: 667 }),
  ]);
  const GUILD_REGISTRY_BY_ID = new Map(GUILD_REGISTRY.map((guild) => [guild.gameGuildId, guild]));
  const GUILD_REGISTRY_BY_NAME = new Map(GUILD_REGISTRY.map((guild) => [guild.gameGuildName.toLocaleLowerCase(), guild]));
  const DEFAULT_API_BASE = "https://mwi.adudu.lol";
  const COMBAT_ABILITY_ICON_BASE = "https://mwi-guild.43.167.210.211.sslip.io/dist/icons/abilities";
  const COMBAT_ASSIGNMENT_CACHE_MS = 5 * 60 * 1000;
  const COMBAT_ASSIGNMENT_POLL_MS = 2 * 60 * 1000;
  const COMBAT_TRIAL_CARD_SELECTOR = "div[class*=trialTile]";
  const PAGE_BRIDGE_CHANNEL = "adudu-mwi-guild-snapshot-v1";
  const UI_COLLAPSED_KEY = "uiCollapsed";
  const UI_POSITION_KEY = "uiCollapsedPosition";
  // A reporter's secret remains necessary for roster, weekly-trial, signup and
  // batch uploads. Ordinary individual snapshot uploads no longer require a
  // secret.
  const MEMBER_TOKEN_PREFIX = "mwiGuildMemberToken:";
  /**
   * Reporter secrets are per guild *and* per character: one browser profile
   * holds several MWI characters, and inheriting the previous character's
   * secret sent it under the wrong name (401) or, worse, let one character act
   * as another. Without a detected character — or when this function is loaded
   * on its own, as the transport unit tests do — the key falls back to the
   * guild scope so a stable key still exists.
   */
  function memberTokenKey(memberId) {
    const slug = apiSlug();
    if (!slug) return "";
    const detected = memberId ?? (typeof detectedMemberId === "function" ? detectedMemberId() : "");
    const member = String(detected ?? "").trim();
    return member ? `${MEMBER_TOKEN_PREFIX}${slug}:${member}` : `${MEMBER_TOKEN_PREFIX}${slug}`;
  }
  const UI = Object.freeze({
    root: "adudu-guild-sync",
    list: "adudu-guild-sync-loadouts",
    status: "adudu-guild-sync-status",
    bridge: "adudu-guild-sync-bridge",
    collect: "adudu-guild-collect-bridge",
    collectButton: "adudu-guild-collect",
    collectPause: "adudu-guild-collect-pause",
    collectProgress: "adudu-guild-collect-progress",
    actions: "adudu-guild-sync-actions",
    tokenEdit: "adudu-guild-sync-token-edit",
    tokenRow: "adudu-guild-sync-token-row",
    token: "adudu-guild-sync-token",
    tokenPaste: "adudu-guild-sync-token-paste",
    tokenClear: "adudu-guild-sync-token-clear",
  });
  const HYDRATION_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 12000];
  // Follow game language (i18nextLng). Do not use the browser UI language.
  const zh = Object.freeze({
    ariaLabel: "adudu-guild-trial-sync",
    heading: "adudu · 公会试炼资料",
    intro: "TMD / Wandering ICarus 通用；登录后自动同步本周试炼类型、怪物面板、当前名单、双 Boss 报名及全部配装，职业与请假在 Web 控制台（mwi.adudu.lol）维护。",
    waitingCharacter: "等待读取角色资料",
    syncNow: "立即同步",
    exportBackup: "导出备份",
    guildLabel: (slug) => `公会：${slug || "未识别"}`,
    collectAll: "采集全会资料与报名配装",
    collectPause: "暂停",
    collectResume: "继续",
    collectCancel: "取消",
    collectNotReporter: "只有可信上报者才能采集全会资料。",
    collectProgress: (current, total, memberId) => `正在采集 ${current}/${total}：${memberId}…`,
    collectProgressPaused: (current, total) => `已暂停（${current}/${total}），点「继续」恢复。`,
    collectPausedNow: (current, total) => `已暂停（${current}/${total}）。`,
    collectDone: (uploaded, failed, total) => `全会采集完成：成功 ${uploaded}、失败 ${failed}、共 ${total} 人。`,
    collectCancelled: (done, total) => `已取消采集（${done}/${total}）。`,
    collectNoMembers: "未读取到公会成员名单；请先打开「公会」界面。",
    collectProfileTimeout: (memberId) => `${memberId} 的资料未在超时前返回`,
    collectLoadoutTimeout: (memberId, kind) => `${memberId} 的${kind === "combat" ? "战斗" : "生活"}报名配装未在超时前返回`,
    collectUploadFailed: (memberId, detail) => `${memberId} 上传失败（${detail}）`,
    collectPausedEnd: "采集已暂停，已停止发送请求。",
    collectCombatLoadoutName: "公会试炼报名配装（战斗）",
    collectSkillingLoadoutName: "公会试炼报名配装（生活）",
    collectWornLoadoutName: "当前穿戴",
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
    notRegisteredGuildYet: "尚未从游戏确认当前角色属于 TMD 或 Wandering ICarus；请打开公会界面后重试。",
    notRegisteredGuildDetail: (detail) => `尚未从游戏确认当前角色所属公会（${detail}）。请打开「公会」界面后点「立即同步」。`,
    waitingEquipmentAuto: "尚未读取到可用配装装备，正在等待游戏数据…",
    waitingEquipmentManual: "尚未从游戏读取到可用配装装备；请等待游戏加载完成后重试",
    checkingEligibility: (memberId) => `正在检查 ${memberId} 的公会成员资格…`,
    notEligible: (memberId) => `当前角色 ${memberId} 不在本会成员名单中，不会上传资料。`,
    syncingRoster: (count) => `正在同步当前名单（${count} 人）…`,
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
    tokenLabel: "上报者口令（全会采集、名单和本周试炼使用）",
    tokenPlaceholder: "仅授权上报者需要",
    tokenPaste: "粘贴口令",
    tokenClear: "清空",
    tokenPasteUnsupported: "无法直接读取剪贴板，请点口令框后按 Ctrl+V / ⌘V 粘贴。",
    tokenSave: "保存口令",
    tokenSaved: "口令已保存，将随同步一起发送。",
    tokenEdit: "设置上报口令",
    tokenCancel: "取消",
    tokenCleared: "已清除本角色的上报口令。",
    tokenMissing: "缺少成员同步口令，无法上传快照。",
    tokenRejected: "成员同步口令无效或已过期，请向管理员重新领取。",
    reporterTokenMissing: "未填上报者口令（仅同步个人配装）、",
    collectNeedsToken: "请先填写上报者口令，再执行全会采集。",
  });
  const en = Object.freeze({
    ariaLabel: "adudu-guild-trial-sync",
    heading: "adudu · Guild Trial Sync",
    intro: "TMD and Wandering ICarus. After login, auto-syncs this week's trials, monster panels, roster, dual-boss signups, and all loadouts. Manage combat roles and leave on the Web console (mwi.adudu.lol).",
    waitingCharacter: "Waiting for character data",
    syncNow: "Sync now",
    exportBackup: "Export backup",
    guildLabel: (slug) => `Guild: ${slug || "unrecognized"}`,
    collectAll: "Collect every member's profile and signup loadouts",
    collectPause: "Pause",
    collectResume: "Resume",
    collectCancel: "Cancel",
    collectNotReporter: "Only trusted reporters can collect the whole guild.",
    collectProgress: (current, total, memberId) => `Collecting ${current}/${total}: ${memberId}…`,
    collectProgressPaused: (current, total) => `Paused (${current}/${total}). Press Resume to continue.`,
    collectPausedNow: (current, total) => `Paused (${current}/${total}).`,
    collectDone: (uploaded, failed, total) => `Collection finished: ${uploaded} uploaded, ${failed} failed, ${total} members.`,
    collectCancelled: (done, total) => `Collection cancelled (${done}/${total}).`,
    collectNoMembers: "No guild roster yet; open the Guild panel first.",
    collectProfileTimeout: (memberId) => `No profile reply for ${memberId} before the timeout`,
    collectLoadoutTimeout: (memberId, kind) => `No ${kind} signup loadout reply for ${memberId} before the timeout`,
    collectUploadFailed: (memberId, detail) => `${memberId} upload failed (${detail})`,
    collectPausedEnd: "Collection paused; no further requests were sent.",
    collectCombatLoadoutName: "Guild trial signup loadout (combat)",
    collectSkillingLoadoutName: "Guild trial signup loadout (skilling)",
    collectWornLoadoutName: "Currently worn",
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
    notRegisteredGuildYet: "Could not confirm this character is in TMD or Wandering ICarus. Open the guild panel and try again.",
    notRegisteredGuildDetail: (detail) => `Could not confirm the guild membership (${detail}). Open the Guild panel, then Sync Now.`,
    waitingEquipmentAuto: "No usable loadout equipment yet; waiting for game data…",
    waitingEquipmentManual: "No usable loadout equipment was captured. Wait for the game to finish loading and try again.",
    checkingEligibility: (memberId) => `Checking guild membership for ${memberId}…`,
    notEligible: (memberId) => `Character ${memberId} is not on the guild roster; nothing will be uploaded.`,
    syncingRoster: (count) => `Syncing roster (${count} members)…`,
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
    tokenLabel: "Reporter secret (guild-wide collection and roster sync)",
    tokenPlaceholder: "Only needed by authorized reporters",
    tokenPaste: "Paste secret",
    tokenClear: "Clear",
    tokenPasteUnsupported: "Cannot read clipboard directly; click the box and press Ctrl+V / ⌘V.",
    tokenSave: "Save secret",
    tokenSaved: "Secret saved; it will be sent with every sync.",
    tokenEdit: "Set reporter secret",
    tokenCancel: "Cancel",
    tokenCleared: "This character's reporter secret was cleared.",
    tokenMissing: "No member sync secret yet, so the snapshot cannot be uploaded.",
    tokenRejected: "The member sync secret is missing or no longer valid. Ask an admin for a new one.",
    reporterTokenMissing: "no reporter secret (personal loadouts only), ",
    collectNeedsToken: "Enter the reporter secret before collecting the whole guild.",
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
    guildBuildingLevelCaptured: false,
    guildBuildingDetailMap: {},
    combatMonsterDetailMap: {},
    loadouts: [],
    authorizedEquipment: [],
    itemByHash: new Map(),
    skills: [],
    learnedAbilities: [],
    auras: [],
    characterHouseRoomMap: undefined,
    characterAchievements: undefined,
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
  const characterIdFrom = (value) => {
    if (!value || typeof value !== "object") return "";
    const id = value.characterId ?? value.characterID
      ?? value.character?.id ?? value.character?.characterId ?? value.character?.characterID
      ?? (value.character || value.name || value.characterName ? value.id : undefined);
    return id == null || id === "" ? "" : String(id);
  };
  const loadoutOwnerId = (loadout) => {
    const direct = loadout?.characterId ?? loadout?.character_id ?? loadout?.characterID;
    if (direct != null && direct !== "") return String(direct);
    for (const reference of values(loadout?.wearableMap)) {
      const raw = typeof reference === "string"
        ? reference
        : reference && typeof reference === "object"
          ? String(reference.hash ?? reference.itemHash ?? reference.id ?? "")
          : "";
      const parts = raw.split("::");
      if (parts.length >= 4 && String(parts[2]).startsWith("/items/") && parts[0]) {
        return String(parts[0]);
      }
    }
    return "";
  };
  const urlCharacterId = () => {
    try {
      return String(new URLSearchParams(location.search).get("characterId") || "");
    } catch {
      return "";
    }
  };
  const liveCharacterId = () => {
    try {
      const page = typeof unsafeWindow === "object" ? unsafeWindow : window;
      const core = page?.MWI_QUEUE_PLANNER?.getGameCore?.()?.state;
      return characterIdFrom(core?.character) || characterIdFrom(core);
    } catch {
      return "";
    }
  };
  // URL and live Game Core identify the signed-in character. Do not fall back
  // to plugin state here, or a stale cache character would lock the session.
  function currentCharacterId() {
    return liveCharacterId() || urlCharacterId();
  }
  function resetOwnedCharacterState() {
    state.character = {};
    state.guild = {};
    state.guildCharacterMap = {};
    state.guildSharableCharacterMap = {};
    state.guildTrialSignupLevelMap = {};
    state.guildWeeklyTrialSet = {};
    state.guildBuildingLevelDict = {};
    state.guildBuildingLevelCaptured = false;
    state.characterHouseRoomMap = undefined;
    state.characterAchievements = undefined;
    state.loadouts = [];
    state.authorizedEquipment = [];
    state.itemByHash = new Map();
    state.skills = [];
    state.learnedAbilities = [];
    state.auras = [];
    resetCollectorIdentity("");
  }

  /**
   * Reporter controls, the token field and the eligibility cache belong to one
   * signed-in character within one guild. Switching to another character (or
   * guild) must clear them and show that character's own stored secret, never
   * the previous one's.
   */
  function resetCollectorIdentity(memberId = detectedMemberId()) {
    // Outside the full script (unit-test slices of this region) the collector
    // does not exist yet; there is nothing to reset then.
    if (typeof collectState !== "object" || !collectState) return;
    const slug = apiSlug();
    const member = String(memberId ?? "").trim();
    const scope = `${slug}:${member}`;
    if (scope === collectState.scopeKey) return;
    const previousSlug = String(collectState.scopeSlug ?? "");
    const previousMember = String(collectState.scopeMember ?? "");
    collectState.scopeKey = scope;
    collectState.scopeSlug = slug;
    collectState.scopeMember = member;
    // Leaving a character (member becomes empty) and moving it to another
    // guild both invalidate in-flight work. A guild that only becomes known
    // for the same character — the normal cold start — is not a switch.
    const memberLeft = Boolean(previousMember) && previousMember !== member;
    const guildMoved = Boolean(previousMember) && Boolean(previousSlug) && Boolean(slug) && previousSlug !== slug;
    if (memberLeft || guildMoved) {
      collectState.scopeGeneration = (collectState.scopeGeneration ?? 0) + 1;
    }
    collectState.uploader = "";
    collectState.eligibilityMemberId = "";
    collectState.eligibilityCheckedAt = 0;
    automaticSync.lastSignature = "";
    // A guild-wide run belongs to the reporter who started it; switching the
    // character must not let that run keep posting under the new identity.
    if (collectState.running) cancelCollect();
    syncCollectorTokenField();
    renderCollectControls();
  }

  /**
   * The reporter secret box is created only when a reporter asks for it, and
   * removed again as soon as it is saved or closed. Crucially, it is *never* an
   * `<input>` (let alone `input[type=password]`): in 0.6.31 creating a password
   * input in the main document coincided with immediate autofill of the game's
   * item search box and the secret box. Instead, the raw secret lives
   * solely in a lexical closure variable (`rawSecret`), while the DOM node is a
   * non-form `div[role=textbox]` that renders only `•` bullets (or the
   * placeholder when empty). A stored secret is never read back into the DOM.
   */
  function closeReporterTokenField() {
    const row = document.getElementById(UI.tokenRow);
    if (!row) return;
    if (typeof row.__aduduClearSecret === "function") row.__aduduClearSecret();
    const input = row.querySelector(`#${UI.token}`);
    if (input) {
      input.value = "";
      input.textContent = "";
    }
    row.remove();
  }

  function openReporterTokenField() {
    // Only a character the guild API answered as a reporter may open this; an
    // ordinary member has no business holding a credential control at all.
    if (!collectState.uploader) return;
    if (document.getElementById(UI.tokenRow)) return;
    const anchor = document.getElementById(UI.actions);
    if (!anchor) return;
    const row = document.createElement("div");
    row.id = UI.tokenRow;
    row.style.cssText = "display:flex;gap:5px;flex-wrap:wrap;margin:6px 0";
    let rawSecret = "";
    let draftVersion = 0;
    let closed = false;
    let renderedText = "";
    let updatingMask = false;
    const maskFor = (secret) => (secret ? "•".repeat(String(secret).length) : "");
    const tokenBox = document.createElement("div");
    tokenBox.id = UI.token;
    tokenBox.tabIndex = 0;
    tokenBox.setAttribute("role", "textbox");
    tokenBox.setAttribute("tabindex", "0");
    tokenBox.setAttribute("aria-label", tr("tokenLabel"));
    tokenBox.setAttribute("autocomplete", "off");
    tokenBox.setAttribute("autocapitalize", "off");
    tokenBox.setAttribute("autocorrect", "off");
    tokenBox.setAttribute("spellcheck", "false");
    tokenBox.setAttribute("data-form-type", "other");
    tokenBox.setAttribute("data-lpignore", "true");
    tokenBox.setAttribute("data-1p-ignore", "true");
    tokenBox.setAttribute("data-bwignore", "true");
    tokenBox.placeholder = tr("tokenPlaceholder");
    tokenBox.style.cssText = "flex:1 1 120px;min-width:0;min-height:24px;padding:4px 6px;border-radius:6px;border:1px solid #7f96dd;background:#0f1626;color:#8fa2d6;font:12px/1.3 system-ui,sans-serif;cursor:text;user-select:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    const findAccessor = (target, prop) => {
      for (let cur = target; cur; cur = Object.getPrototypeOf(cur)) {
        const desc = Object.getOwnPropertyDescriptor(cur, prop);
        if (desc && (desc.get || desc.set)) return desc;
      }
      return null;
    };
    const nativeTextContent = findAccessor(tokenBox, "textContent");
    const writeRenderedText = (text) => {
      renderedText = String(text ?? "");
      updatingMask = true;
      try {
        if (nativeTextContent?.set) nativeTextContent.set.call(tokenBox, renderedText);
      } finally {
        updatingMask = false;
      }
    };
    const syncMask = () => {
      if (closed) {
        writeRenderedText("");
        return;
      }
      const mask = maskFor(rawSecret);
      const empty = mask.length === 0;
      tokenBox.setAttribute("data-empty", empty ? "true" : "false");
      tokenBox.setAttribute("data-masked-length", String(rawSecret.length));
      writeRenderedText(empty ? tr("tokenPlaceholder") : mask);
      tokenBox.style.color = empty ? "#8fa2d6" : "#f7f9ff";
      tokenBox.style.letterSpacing = empty ? "normal" : "2px";
    };
    const applySecretText = (candidate) => {
      if (closed) return false;
      const cleaned = String(candidate ?? "").replace(/[\r\n]+/g, "");
      if (!cleaned) return false;
      draftVersion += 1;
      rawSecret = cleaned;
      syncMask();
      return true;
    };
    const clearDraft = () => {
      draftVersion += 1;
      rawSecret = "";
      syncMask();
    };
    const observer = typeof MutationObserver === "function"
      ? new MutationObserver(() => {
        if (!updatingMask && !closed && tokenBox.textContent !== renderedText) {
          syncMask();
        }
      })
      : null;
    if (observer) {
      try {
        observer.observe(tokenBox, { childList: true, characterData: true, subtree: true });
      } catch { /* non-DOM test double */ }
    }
    row.__aduduClearSecret = () => {
      closed = true;
      draftVersion += 1;
      rawSecret = "";
      if (observer) observer.disconnect();
      writeRenderedText("");
    };
    Object.defineProperty(tokenBox, "value", {
      configurable: true,
      enumerable: true,
      get() {
        return closed ? "" : maskFor(rawSecret);
      },
      set() {
        // Reject unsolicited programmatic / autofill value assignments: the
        // secret only enters through trusted paste, clipboard read or trusted
        // keystrokes, and the DOM never keeps a raw string in `.value`.
        if (!closed) syncMask();
      },
    });
    Object.defineProperty(tokenBox, "textContent", {
      configurable: true,
      enumerable: true,
      get() {
        return nativeTextContent?.get ? nativeTextContent.get.call(tokenBox) : renderedText;
      },
      set() {
        // Synchronously reject direct `tokenBox.textContent = ...` writes even
        // when no input/change event is dispatched afterwards.
        if (!updatingMask && !closed) syncMask();
      },
    });
    Object.defineProperty(tokenBox, "innerText", {
      configurable: true,
      enumerable: true,
      get() {
        return tokenBox.textContent;
      },
      set() {
        if (!updatingMask && !closed) syncMask();
      },
    });
    tokenBox.addEventListener("click", () => {
      if (typeof tokenBox.focus === "function") tokenBox.focus();
    });
    const handlePaste = (event) => {
      if (typeof event?.preventDefault === "function") event.preventDefault();
      if (typeof event?.stopPropagation === "function") event.stopPropagation();
      // Only accept user-initiated (trusted) paste events; reject synthetic
      // events dispatched by scripts or autofill probes.
      if (event?.isTrusted !== true) {
        syncMask();
        return;
      }
      const pasted = event?.clipboardData?.getData?.("text/plain")
        || event?.clipboardData?.getData?.("text")
        || "";
      applySecretText(pasted);
    };
    tokenBox.addEventListener("paste", handlePaste);
    row.addEventListener("paste", handlePaste);
    tokenBox.addEventListener("keydown", (event) => {
      // Only accept user-initiated (trusted) keystrokes; reject synthetic
      // KeyboardEvents dispatched by scripts or autofill probes.
      if (event?.isTrusted !== true) {
        if (typeof event?.preventDefault === "function") event.preventDefault();
        syncMask();
        return;
      }
      const key = String(event?.key ?? "");
      if (key === "Backspace" || key === "Delete") {
        if (typeof event?.preventDefault === "function") event.preventDefault();
        draftVersion += 1;
        rawSecret = rawSecret.slice(0, -1);
        syncMask();
        return;
      }
      if (key === "Enter") {
        if (typeof event?.preventDefault === "function") event.preventDefault();
        saveToken();
        return;
      }
      if (key === "Escape") {
        if (typeof event?.preventDefault === "function") event.preventDefault();
        cancelToken();
        return;
      }
      if (event?.ctrlKey || event?.metaKey || event?.altKey) return;
      if (key.length === 1) {
        if (typeof event?.preventDefault === "function") event.preventDefault();
        draftVersion += 1;
        rawSecret += key;
        syncMask();
      }
    });
    tokenBox.addEventListener("input", () => syncMask());
    tokenBox.addEventListener("change", () => syncMask());
    const pasteToken = async () => {
      if (closed) return;
      draftVersion += 1;
      const requestVersion = draftVersion;
      try {
        const clip = (typeof pageContext === "object" && pageContext?.navigator?.clipboard)
          || (typeof navigator === "object" ? navigator.clipboard : null);
        if (typeof clip?.readText !== "function") {
          if (!closed && requestVersion === draftVersion) {
            setStatus(tr("tokenPasteUnsupported"), true);
          }
          return;
        }
        const text = await clip.readText();
        // If the user cleared, typed, pasted, saved or closed while readText()
        // was still in flight, discard the stale clipboard value.
        if (closed || requestVersion !== draftVersion || document.getElementById(UI.tokenRow) !== row) {
          return;
        }
        applySecretText(text);
      } catch {
        if (!closed && requestVersion === draftVersion) {
          setStatus(tr("tokenPasteUnsupported"), true);
        }
      }
    };
    const saveToken = () => {
      const value = String(rawSecret ?? "").trim();
      draftVersion += 1;
      rawSecret = "";
      let key = "";
      try {
        key = memberTokenKey();
        if (!key) { /* guild not resolved yet; nothing to key the secret to */ }
        else if (value) GM_setValue(key, value);
        else GM_deleteValue(key);
      } catch { /* storage unavailable; the field is dropped either way */ }
      // A new secret must not be blocked by the "unchanged payload" guard.
      automaticSync.lastSignature = "";
      closeReporterTokenField();
      setStatus(value ? tr("tokenSaved") : tr("tokenCleared"));
      scheduleAutomaticUpload(400);
    };
    const cancelToken = () => {
      draftVersion += 1;
      rawSecret = "";
      closeReporterTokenField();
      renderCollectControls();
    };
    const pasteButton = actionButton(tr("tokenPaste"), () => void pasteToken());
    pasteButton.id = UI.tokenPaste;
    const clearButton = actionButton(tr("tokenClear"), clearDraft);
    clearButton.id = UI.tokenClear;
    syncMask();
    row.append(
      tokenBox,
      pasteButton,
      clearButton,
      actionButton(tr("tokenSave"), saveToken),
      actionButton(tr("tokenCancel"), cancelToken),
    );
    anchor.after(row);
  }

  function syncCollectorTokenField() {
    // Deliberately empty of secret handling: a character switch must not leave
    // a field behind, and it must never re-read a stored secret into the DOM.
    closeReporterTokenField();
  }

  const positiveGuildId = (value) => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
  };
  const registeredGuildById = (value) => GUILD_REGISTRY_BY_ID.get(positiveGuildId(value)) ?? null;
  const registeredGuildByName = (value) =>
    GUILD_REGISTRY_BY_NAME.get(String(value ?? "").trim().toLocaleLowerCase()) ?? null;
  const registeredGuild = (value) => registeredGuildById(value) ?? registeredGuildByName(value);
  const ownGuildName = (value) => Boolean(registeredGuildByName(value));
  const hasPinnedGuildId = (value) => Boolean(registeredGuildById(value));
  const ownsCurrentGuild = () =>
    ownGuildName(state.guild.name) || hasPinnedGuildId(state.guild.id) || hasPinnedGuildId(state.guild.guildId);
  /**
   * Which registered guild this page belongs to. The name wins because React
   * leftovers can leave a foreign guild id next to the correct name; the id is
   * the fallback when the name has not hydrated yet.
   */
  function activeGuildIdentity() {
    const fromName = registeredGuildByName(state.guild.name)
      ?? registeredGuildByName(state.guild.guildName)
      ?? registeredGuildByName(state.character.guildName);
    if (fromName) return fromName;
    return registeredGuildById(state.guild.id)
      ?? registeredGuildById(state.guild.guildId)
      ?? registeredGuildById(state.character.guildId)
      ?? registeredGuildById(state.character.guildID)
      ?? null;
  }
  function apiSlug() {
    return activeGuildIdentity()?.apiSlug ?? "";
  }
  /** The registered guild id already confirmed by the current state, if any. */
  function pinnedGuildId() {
    const byName = registeredGuildByName(state.guild.name) ?? registeredGuildByName(state.guild.guildName);
    if (byName) return byName.gameGuildId;
    const byId = registeredGuildById(state.guild.id) ?? registeredGuildById(state.guild.guildId);
    return byId ? byId.gameGuildId : null;
  }
  function guildApiUrl(path) {
    const slug = apiSlug();
    return slug ? `${DEFAULT_API_BASE}/api/public/guilds/${slug}${path}` : "";
  }

  function applyCharacterData(candidate) {
    const data = object(candidate);
    const characterInfo = object(data.characterInfo);
    const character = data.character ?? characterInfo.character;
    const incomingId = characterIdFrom(character) || characterIdFrom(characterInfo) || characterIdFrom(data);
    const preferred = currentCharacterId();
    // Same-account alts (and leftover React fibers) must not merge into the
    // signed-in character. YouCan/daydayup/NoCan share one browser profile.
    if (incomingId && preferred && incomingId !== preferred) return;
    const currentId = characterIdFrom(state.character);
    if (incomingId && currentId && incomingId !== currentId) resetOwnedCharacterState();
    if (character && typeof character === "object") state.character = character;
    const guild = data.guild ?? characterInfo.guild;
    const incomingGuildName = String(
      (guild && typeof guild === "object" ? guild.name ?? guild.guildName : "")
      || data.guildName || character?.guildName || characterInfo.character?.guildName || ""
    ).trim();
    const incomingGuildId = [
      guild && typeof guild === "object" ? guild.guildId : undefined,
      guild && typeof guild === "object" ? guild.id : undefined,
      data.guildId,
      data.guildID,
      character?.guildId,
      character?.guildID,
    ].map(positiveGuildId).filter((id) => id != null)
      .sort((left, right) => Number(Boolean(registeredGuildById(right))) - Number(Boolean(registeredGuildById(left))))[0]
      ?? null;
    const incomingForeignName = incomingGuildName && !ownGuildName(incomingGuildName);
    const incomingRegistered = registeredGuildById(incomingGuildId) ?? registeredGuildByName(incomingGuildName);
    // Leftover fibers and guild-list tiles can write a foreign id (Ameratto:
    // 459) without replacing the real guild name. Keep the registered id.
    if (guild && typeof guild === "object" && !(ownsCurrentGuild() && incomingForeignName)) {
      const pinnedId = incomingRegistered?.gameGuildId ?? pinnedGuildId();
      state.guild = {
        ...state.guild,
        ...guild,
        id: pinnedId ?? incomingGuildId ?? guild.id ?? guild.guildId ?? state.guild.id,
        guildId: pinnedId ?? guild.guildId ?? guild.id ?? state.guild.guildId,
        name: incomingGuildName || guild.name || guild.guildName || state.guild.name,
        guildName: guild.guildName ?? guild.name ?? state.guild.guildName,
      };
    }
    if (incomingGuildName && !(ownsCurrentGuild() && incomingForeignName)) {
      state.guild.name = incomingGuildName;
    }
    if (incomingGuildId && !(ownsCurrentGuild() && incomingForeignName)) {
      const keepPinned = hasPinnedGuildId(state.guild.id) && !hasPinnedGuildId(incomingGuildId);
      if (!keepPinned) state.guild.id = incomingRegistered?.gameGuildId ?? incomingGuildId;
      if (state.character && typeof state.character === "object") {
        if (state.character.guildId == null && state.character.guildID == null) {
          state.character.guildId = hasPinnedGuildId(state.guild.id)
            ? state.guild.id
            : incomingGuildId;
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
    const characterHouseRoomMap = data.characterHouseRoomMap ?? data.characterHouseRoomDict
      ?? characterInfo.characterHouseRoomMap ?? characterInfo.characterHouseRoomDict
      ?? character?.characterHouseRoomMap ?? character?.characterHouseRoomDict;
    if (characterHouseRoomMap != null && typeof characterHouseRoomMap === "object") {
      state.characterHouseRoomMap = characterHouseRoomMap;
    }
    const characterAchievements = data.characterAchievements ?? data.characterAchievementMap
      ?? characterInfo.characterAchievements ?? characterInfo.characterAchievementMap
      ?? character?.characterAchievements ?? character?.characterAchievementMap;
    if (characterAchievements != null && typeof characterAchievements === "object") {
      state.characterAchievements = characterAchievements;
    }
    const guildBuildingLevelDict = data.guildBuildingLevelDict ?? data.guildBuildingLevelMap
      ?? data.guild?.guildBuildingLevelMap ?? data.guild?.guildBuildingLevelDict
      ?? character?.guildBuildingLevelMap ?? character?.guildBuildingLevelDict;
    if (guildBuildingLevelDict != null && typeof guildBuildingLevelDict === "object") {
      state.guildBuildingLevelDict = guildBuildingLevelDict;
      state.guildBuildingLevelCaptured = true;
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
      const ownerId = incomingId || preferred || characterIdFrom(state.character);
      const nextLoadouts = values(loadouts).filter((loadout) => {
        const owner = loadoutOwnerId(loadout);
        return !owner || !ownerId || owner === ownerId;
      });
      state.loadouts = mergeLoadouts(state.loadouts, nextLoadouts);
    }
    // The character (or its guild) may just have changed; the reporter panel
    // must follow this character, not the one whose secret is still in the box.
    resetCollectorIdentity(detectedMemberId());
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
        if (candidate && typeof candidate === "object" && (candidate.characterLoadoutDict || candidate.characterLoadoutMap || candidate.characterLabyrinth || candidate.combatUnit || candidate.gameConn || candidate.guildCharacterMap || candidate.guildSharableCharacterMap || candidate.guildTrialSignupLevelDict || candidate.guildWeeklyTrialSet || candidate.characterHouseRoomMap || candidate.characterHouseRoomDict || candidate.characterAchievements || candidate.characterAchievementMap || candidate.guildBuildingLevelDict || candidate.guildBuildingLevelMap || candidate.guild)) {
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
      if (value.character || value.characterInfo || value.characterLoadoutDict || value.characterLoadoutMap || value.characterItems || value.characterSkills || value.characterHouseRoomMap || value.characterHouseRoomDict || value.characterAchievements || value.characterAchievementMap || value.guildCharacterMap || value.guildSharableCharacterMap || value.guildTrialSignupLevelDict || value.guildWeeklyTrialSet || value.guildTrialDetailMap || value.combatMonsterDetailMap || value.guildBuildingLevelDict || value.guildBuildingLevelMap || value.guild) applyCharacterData(value);
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
  const CAPTURE_HOUSE_ROOM_HRIDS = new Set([
    "/house_rooms/archery_range", "/house_rooms/armory", "/house_rooms/brewery", "/house_rooms/dairy_barn",
    "/house_rooms/dining_room", "/house_rooms/dojo", "/house_rooms/forge", "/house_rooms/garden",
    "/house_rooms/gym", "/house_rooms/kitchen", "/house_rooms/laboratory", "/house_rooms/library",
    "/house_rooms/log_shed", "/house_rooms/mystical_study", "/house_rooms/observatory",
    "/house_rooms/sewing_parlor", "/house_rooms/workshop",
  ]);
  const CAPTURE_ACHIEVEMENT_HRIDS = new Set([
    "/achievements/bestiary_points_100", "/achievements/bestiary_points_20", "/achievements/bestiary_points_200",
    "/achievements/bestiary_points_40", "/achievements/bestiary_points_400", "/achievements/brew_gourmet_tea",
    "/achievements/brew_ultra_magic_coffee", "/achievements/build_room_level_1", "/achievements/build_room_level_3",
    "/achievements/build_room_level_6", "/achievements/build_room_level_8", "/achievements/buy_trainee_charm",
    "/achievements/cheesesmith_azure_tool", "/achievements/clear_chimerical_den", "/achievements/clear_enchanted_fortress",
    "/achievements/clear_pirate_cove", "/achievements/clear_sinister_circus", "/achievements/clear_t1_dungeon_10_times",
    "/achievements/coinify_coins_1m", "/achievements/collect_branch_of_insight", "/achievements/collect_butter_of_proficiency",
    "/achievements/collect_thread_of_expertise", "/achievements/collection_points_100", "/achievements/collection_points_1000",
    "/achievements/collection_points_200", "/achievements/collection_points_2000", "/achievements/collection_points_500",
    "/achievements/complete_tutorial", "/achievements/cook_apple_gummy", "/achievements/cook_peach_yogurt",
    "/achievements/cook_spaceberry_cake", "/achievements/craft_celestial_tool_or_outfit", "/achievements/craft_dungeon_equipment",
    "/achievements/craft_jewelry", "/achievements/craft_master_charm", "/achievements/craft_wooden_bow",
    "/achievements/decompose_bamboo_gloves", "/achievements/defeat_chronofrost_sorcerer", "/achievements/defeat_crystal_colossus",
    "/achievements/defeat_demonic_overlord_t1", "/achievements/defeat_dusk_revenant", "/achievements/defeat_gobo_chieftain",
    "/achievements/defeat_jerry", "/achievements/defeat_jerry_t5", "/achievements/defeat_luna_empress",
    "/achievements/defeat_marine_huntress", "/achievements/defeat_red_panda", "/achievements/defeat_shoebill",
    "/achievements/defeat_stalactite_golem_t5", "/achievements/defeat_the_watcher", "/achievements/enhance_level_80_to_10",
    "/achievements/enhance_level_90_to_10", "/achievements/enhance_to_10", "/achievements/enhance_to_3",
    "/achievements/enhance_to_6", "/achievements/equip_expert_task_badge", "/achievements/equip_ginkgo_weapon",
    "/achievements/gather_milk", "/achievements/labyrinth_floor_2", "/achievements/labyrinth_floor_4",
    "/achievements/labyrinth_floor_6", "/achievements/labyrinth_floor_8", "/achievements/learn_ability",
    "/achievements/learn_special_ability", "/achievements/refine_dungeon_equipment",
    "/achievements/tailor_gluttonous_or_guzzling_pouch", "/achievements/tailor_medium_pouch",
    "/achievements/tailor_umbral_tunic", "/achievements/task_tokens_10", "/achievements/total_level_100",
    "/achievements/total_level_1000", "/achievements/total_level_1500", "/achievements/total_level_1800",
    "/achievements/total_level_250", "/achievements/total_level_500", "/achievements/transmute_philosophers_stone",
    "/achievements/woodcut_arcane_tree",
  ]);
  const CAPTURE_SHRINE_HRIDS = Object.freeze({
    "/guild_shrines/force": "/shrines/force", "/guild_shrines/tempo": "/shrines/tempo",
    "/guild_shrines/spirit": "/shrines/spirit", "/guild_shrines/scholar": "/shrines/scholar",
    "/guild_shrines/rarity": "/shrines/rarity",
    "/shrines/force": "/shrines/force", "/shrines/tempo": "/shrines/tempo",
    "/shrines/spirit": "/shrines/spirit", "/shrines/scholar": "/shrines/scholar",
    "/shrines/rarity": "/shrines/rarity",
  });
  const captureText = (value) => typeof value === "string" ? value.trim() : (Number.isFinite(value) ? String(value) : "");
  const captureObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const captureEntries = (value) => Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry])
    : value && typeof value === "object" && typeof value.entries === "function" && Number.isFinite(Number(value.size))
      ? [...value.entries()]
      : value && typeof value === "object" ? Object.entries(value) : [];
  const captureBoundedInteger = (value, max) => {
    if (value == null || (typeof value === "string" && value.trim() === "")) return null;
    if (typeof value !== "number" && typeof value !== "string") return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= max ? number : null;
  };
  const captureHouseRooms = (value) => Object.fromEntries(captureEntries(value).flatMap(([mapKey, raw]) => {
    const row = captureObject(raw);
    const hrid = captureText(row.houseRoomHrid ?? mapKey);
    const level = captureBoundedInteger(row.level ?? raw, 8);
    return CAPTURE_HOUSE_ROOM_HRIDS.has(hrid) && level != null ? [[hrid, level]] : [];
  }));
  const captureAchievements = (value) => Object.fromEntries(captureEntries(value).flatMap(([mapKey, raw]) => {
    const row = captureObject(raw);
    const hrid = captureText(row.achievementHrid ?? mapKey);
    const completed = raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "isCompleted")
      ? raw.isCompleted : raw;
    if (!CAPTURE_ACHIEVEMENT_HRIDS.has(hrid) || (completed !== true && completed !== false && completed !== 0 && completed !== 1)) return [];
    return [[hrid, completed === true || completed === 1]];
  }));
  const captureShrines = (value) => Object.fromEntries(captureEntries(value).flatMap(([mapKey, raw]) => {
    const hrid = CAPTURE_SHRINE_HRIDS[captureText(mapKey)];
    const row = captureObject(raw);
    const level = captureBoundedInteger(row.level ?? raw, 20);
    return hrid && level != null ? [[hrid, level]] : [];
  }));
  const permanentCaptureFields = (input) => {
    const character = captureObject(input.character);
    const houseSource = input.characterHouseRoomMap ?? input.characterHouseRoomDict
      ?? character.characterHouseRoomMap ?? character.characterHouseRoomDict;
    const achievementSource = input.characterAchievements ?? input.characterAchievementMap
      ?? character.characterAchievements ?? character.characterAchievementMap;
    const shrineSource = input.guildBuildingLevelCaptured ? input.guildBuildingLevelDict
      : input.guildBuildingLevelDict ?? input.guildBuildingLevelMap
        ?? character.guildBuildingLevelDict ?? character.guildBuildingLevelMap;
    return {
      ...(houseSource == null ? {} : { houseRooms: captureHouseRooms(houseSource) }),
      ...(achievementSource == null ? {} : { achievements: captureAchievements(achievementSource) }),
      ...(shrineSource == null ? {} : { shrines: captureShrines(shrineSource) }),
      ...(houseSource != null && achievementSource != null && shrineSource != null ? { permanentBuffsCaptured: true } : {}),
    };
  };
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
      return safe({ schemaVersion: "2", memberId, displayName: string(input.displayName ?? character.displayName ?? character.name) || memberId, guildId: string(input.guildId ?? character.guildId), capturedAt, source: "manual", sourceSchemaVersion: "mwi-local-exporter-v1", freshness: "fresh", confidence: approvedBuilds.length ? "simulation-ready" : "capability-only", skills: levels(input.skills ?? character.skills), learnedAbilities: levels(input.learnedAbilities ?? character.learnedAbilities), auras: levels(input.auras ?? character.auras), ...permanentCaptureFields(input), loadoutCatalog, approvedBuilds, participation: { eligibleBossHrids: [], preferredBossHrids: [], maxBossAssignments: 1, allowRoleChange: true, allowSkillChange: true }, issues: approvedBuilds.length === requested.length ? [] : ["some-selected-loadouts-were-incomplete-or-not-owned"] });
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
      const houseRoomSource = gameState?.characterHouseRoomMap ?? gameState?.characterHouseRoomDict
        ?? character?.characterHouseRoomMap ?? character?.characterHouseRoomDict;
      const achievementSource = gameState?.characterAchievements ?? gameState?.characterAchievementMap
        ?? character?.characterAchievements ?? character?.characterAchievementMap;
      const shrineSource = gameState?.guildBuildingLevelDict ?? gameState?.guildBuildingLevelMap
        ?? character?.guildBuildingLevelDict ?? character?.guildBuildingLevelMap
        ?? gameState?.guild?.guildBuildingLevelMap ?? gameState?.guild?.guildBuildingLevelDict;
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
        characterHouseRoomMap: houseRoomSource == null ? undefined : houseRoomSource,
        characterAchievements: achievementSource == null ? undefined : achievementSource,
        characterAchievementMap: achievementSource == null ? undefined : dictionary(achievementSource),
        guildBuildingLevelDict: shrineSource == null ? undefined : dictionary(shrineSource),
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
      const coreState = window.MWI_QUEUE_PLANNER?.getGameCore?.()?.state;
      const sessionId = String(
        coreState?.character?.id
        ?? coreState?.character?.characterId
        ?? coreState?.characterId
        ?? new URLSearchParams(window.location.search).get("characterId")
        ?? ""
      );
      const consider = (candidate) => {
        const result = compact(candidate);
        if (!result) return;
        const id = String(result.character?.id ?? result.character?.characterId ?? "");
        if (sessionId && id && sessionId !== id) return;
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
      consider(coreState);
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

  function resetCharacterData() {
    resetOwnedCharacterState();
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
    const live = hydrateFromLiveGame();
    const cache = hydrateFromGameCache();
    if (live || cache) {
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
    const ids = [
      state.guild.guildId,
      state.guild.id,
      state.character.guildId,
      state.character.guildID,
    ].map(positiveGuildId).filter((id) => id != null);
    const name = String(state.guild.name ?? state.guild.guildName ?? state.character.guildName ?? "").trim();
    const registered = activeGuildIdentity();
    return { id: registered?.gameGuildId ?? ids[0] ?? null, name };
  }
  function guildConfirmDetail() {
    const guild = detectedGameGuild();
    const parts = [];
    if (!registeredGuildByName(guild.name)) {
      parts.push(guild.name ? `guild=${guild.name}` : "missing guild name");
    }
    if (!registeredGuildById(guild.id)) {
      parts.push(guild.id != null ? `guildId=${guild.id}∉{369,667}` : "missing guild id");
    }
    return parts.join("; ") || "incomplete guild state";
  }
  function confirmedGuild() {
    return Boolean(activeGuildIdentity());
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
        resolve(confirmedGuild());
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
  async function ensureGuildConfirmed() {
    hydrateFromGameCache();
    hydrateFromLiveGame();
    if (confirmedGuild()) return true;
    return requestPageBridgeState();
  }
  function guildRosterPayload() {
    if (!confirmedGuild()) return null;
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
    if (!Number.isFinite(result.abilityHaste)) result.abilityHaste = 0;
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
    if (!confirmedGuild()) return null;
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
    if (!confirmedGuild()) return null;
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
      characterHouseRoomMap: state.characterHouseRoomMap,
      characterAchievements: state.characterAchievements,
      guildBuildingLevelDict: state.guildBuildingLevelCaptured ? state.guildBuildingLevelDict : undefined,
      memberId: detectedMemberId() || undefined,
      displayName: detectedMemberId() || undefined,
      guildId: apiSlug() || undefined,
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
  function gmXmlHttpRequestFn() {
    if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest;
    const gm = typeof GM === "object" && GM ? GM : null;
    if (gm && typeof gm.xmlHttpRequest === "function") return gm.xmlHttpRequest;
    return null;
  }
  function memberToken() {
    try {
      const key = memberTokenKey();
      return key ? String(GM_getValue(key, "") ?? "").trim() : "";
    } catch {
      return "";
    }
  }
  /**
   * The member sync secret is ours, and only ours: it identifies this character
   * to the guild API. Report JSON falls back to GitHub raw and Gitee raw when the
   * API is unreachable, so the secret must never ride along to a third-party host.
   */
  function isGuildApiUrl(url) {
    try {
      const origin = new URL(String(url)).origin;
      return origin === new URL(DEFAULT_API_BASE).origin || origin === "https://api.adudu.lol" || origin === "https://mwi.adudu.lol";
    } catch {
      return false;
    }
  }
  function jsonRequestHeaders(data, url) {
    const headers = data == null ? {} : { "content-type": "application/json" };
    const token = memberToken();
    if (token && isGuildApiUrl(url)) headers.authorization = `Bearer ${token}`;
    return headers;
  }
  function requestJsonWithFetch({ method, url, headers, body }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    return fetch(url, {
      method,
      headers,
      body,
      mode: "cors",
      credentials: "omit",
      signal: controller.signal,
    }).then(async (response) => {
      clearTimeout(timer);
      return { status: response.status, responseText: await response.text() };
    }, (error) => {
      clearTimeout(timer);
      if (error && error.name === "AbortError") throw new Error(tr("syncTimeout"));
      throw new Error(tr("syncUnreachable"));
    });
  }
  function requestJsonWithGm(gmRequest, { method, url, headers, body }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = 0;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      timer = setTimeout(() => finish(reject, new Error(tr("syncTimeout"))), 30_000);
      try {
        const result = gmRequest({
          method,
          url,
          headers,
          data: body,
          timeout: 30_000,
          anonymous: true,
          fetch: false,
          onload: (response) => finish(resolve, response),
          ontimeout: () => finish(reject, new Error(tr("syncTimeout"))),
          onerror: () => finish(reject, new Error(tr("syncUnreachable"))),
        });
        if (result && typeof result.then === "function") {
          result.then(
            (response) => finish(resolve, response),
            () => finish(reject, new Error(tr("syncUnreachable"))),
          );
        }
      } catch {
        finish(reject, new Error(tr("syncUnreachable")));
      }
    });
  }
  function requestJson({ method, url, data }) {
    const headers = jsonRequestHeaders(data, url);
    const body = data == null ? undefined : JSON.stringify(data);
    const gmRequest = gmXmlHttpRequestFn();
    if (!gmRequest) return requestJsonWithFetch({ method, url, headers, body });
    return requestJsonWithGm(gmRequest, { method, url, headers, body }).catch((error) => {
      if (error?.message !== tr("syncUnreachable") && error?.message !== tr("syncTimeout")) throw error;
      return requestJsonWithFetch({ method, url, headers, body });
    });
  }
  async function requestAssignmentJson({ path }) {
    const url = guildApiUrl(path);
    if (!url) throw new Error(tr("notRegisteredGuildYet"));
    const response = await requestJson({ method: "GET", url });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    return response;
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

  function assignmentAttemptFresh(state, memberId = detectedMemberId()) {
    if (!memberId || state.lastMemberId !== memberId || !state.fetchedAt) return false;
    const windowMs = state.document ? COMBAT_ASSIGNMENT_CACHE_MS : COMBAT_ASSIGNMENT_POLL_MS;
    return Date.now() - state.fetchedAt < windowMs;
  }

  function scheduleLifeAssignmentRefresh(delay = 0) {
    clearTimeout(lifeAssignmentState.timer);
    const memberId = detectedMemberId();
    if (!memberId) return;
    if (assignmentAttemptFresh(lifeAssignmentState, memberId)) {
      if (lifeAssignmentState.document && document.querySelector(COMBAT_TRIAL_CARD_SELECTOR)) {
        renderLifeAssignmentUi();
      }
      return;
    }
    lifeAssignmentState.timer = setTimeout(() => void refreshLifeAssignment(), delay);
  }

  async function refreshLifeAssignment({ force = false } = {}) {
    const memberId = detectedMemberId();
    if (!memberId || !confirmedGuild() || lifeAssignmentState.inFlight) return;
    const cards = [...document.querySelectorAll(COMBAT_TRIAL_CARD_SELECTOR)];
    if (!force && assignmentAttemptFresh(lifeAssignmentState, memberId)) {
      if (cards.length && lifeAssignmentState.document) renderLifeAssignmentUi();
      return;
    }
    lifeAssignmentState.inFlight = true;
    lifeAssignmentState.lastMemberId = memberId;
    if (!lifeAssignmentState.document && !lifeAssignmentState.fetchedAt) {
      setStatus(tr("lifeAssignmentLoading"));
    }
    try {
      const response = await requestAssignmentJson({ path: "/life-assignments/current" });
      const source = JSON.parse(response.responseText || "{}");
      lifeAssignmentState.document = normalizeLifeAssignment(source);
      lifeAssignmentState.fetchedAt = Date.now();
      renderLifeAssignmentUi();
    } catch (error) {
      lifeAssignmentState.document = null;
      lifeAssignmentState.fetchedAt = Date.now();
      lifeAssignmentState.mismatch = null;
      clearLifeAssignmentUi();
      setStatus(tr("lifeAssignmentUnavailable"), true);
      console.warn("[adudu-guild-trial-sync] latest life assignment unavailable", error?.message || error);
    } finally {
      lifeAssignmentState.inFlight = false;
    }
  }

  function scheduleCombatAssignmentRefresh(delay = 0) {
    clearTimeout(combatAssignmentState.timer);
    const memberId = detectedMemberId();
    if (!memberId) return;
    if (assignmentAttemptFresh(combatAssignmentState, memberId)) {
      if (combatAssignmentState.document && document.querySelector(COMBAT_TRIAL_CARD_SELECTOR)) {
        renderCombatAssignmentUi();
      }
      return;
    }
    combatAssignmentState.timer = setTimeout(() => void refreshCombatAssignment(), delay);
  }

  async function refreshCombatAssignment({ force = false } = {}) {
    const memberId = detectedMemberId();
    if (!memberId || !confirmedGuild() || combatAssignmentState.inFlight) return;
    const cards = [...document.querySelectorAll(COMBAT_TRIAL_CARD_SELECTOR)];
    if (!force && assignmentAttemptFresh(combatAssignmentState, memberId)) {
      if (cards.length && combatAssignmentState.document) renderCombatAssignmentUi();
      return;
    }
    combatAssignmentState.inFlight = true;
    combatAssignmentState.lastMemberId = memberId;
    if (!combatAssignmentState.document && !combatAssignmentState.fetchedAt) {
      setStatus(tr("assignmentLoading"));
    }
    try {
      const response = await requestAssignmentJson({ path: "/assignments/current" });
      const source = JSON.parse(response.responseText || "{}");
      combatAssignmentState.document = normalizeCombatAssignment(source);
      combatAssignmentState.fetchedAt = Date.now();
      renderCombatAssignmentUi();
    } catch (error) {
      combatAssignmentState.document = null;
      combatAssignmentState.fetchedAt = Date.now();
      clearCombatAssignmentOnly();
      setStatus(tr("assignmentUnavailable"), true);
      console.warn("[adudu-guild-trial-sync] latest combat assignment unavailable", error?.message || error);
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

  function catalogMissingUsableEquipment(snapshot) {
    const catalog = Array.isArray(snapshot?.loadoutCatalog) ? snapshot.loadoutCatalog : [];
    return catalog.length === 0
      || catalog.every((loadout) => !Array.isArray(loadout?.equipment) || loadout.equipment.length === 0);
  }

  /* ------------------------------------------------------------------ *
   * Whole-guild collection
   *
   * The game answers handleViewProfile(name) and handleViewLoadout(id, ...)
   * with profile_shared / loadout_shared packets, which its own handlers turn
   * into `sharableProfile` / `sharableLoadout` state plus a modal. A reporter
   * collecting ~115 members cannot have that modal open 115 times, so the
   * collection runs in page context where it temporarily wraps the two
   * handlers, records the payloads, and suppresses the UI state write.
   * ------------------------------------------------------------------ */
  const COLLECT_CHANNEL = "adudu-mwi-guild-collect-v1";
  const COLLECT_PAGE_FLAG = "__ADUDU_GUILD_COLLECT__";
  const COLLECT_MIN_INTERVAL_MS = 300;
  const COLLECT_MAX_INTERVAL_MS = 400;
  const COLLECT_PROFILE_TIMEOUT_MS = 2500;
  const COLLECT_LOADOUT_TIMEOUT_MS = 2000;
  const COLLECT_ELIGIBILITY_CACHE_MS = 10 * 60 * 1000;
  const COLLECT_PROFILE_HANDLER = "handleMessageProfileShared";
  const COLLECT_LOADOUT_HANDLER = "handleMessageLoadoutShared";

  /**
   * Runs inside the game page. Every function below is self-contained: it is
   * serialized with `toString()`, so it must not close over userscript scope.
   */
  function collectPageMain(channel) {
    if (window.__ADUDU_GUILD_COLLECT__) return;
    window.__ADUDU_GUILD_COLLECT__ = true;

    const CORE_KEYS = [
      "guildWeeklyTrialSet", "character", "guildCharacterMap", "guildCharacterDict",
      "guildSharableCharacterMap", "guildSharableCharacterDict", "guildTrialSignupLevelDict",
    ];
    // Client releases rename the two reply handlers; match by intent, not by
    // one hardcoded spelling.
    const PROFILE_HANDLER = /^handle(Message)?ProfileShared$/;
    const LOADOUT_HANDLER = /^handle(Message)?(Loadout|GuildTrialLoadout)Shared$/;
    const values = (value) => Array.isArray(value) ? value
      : value && typeof value === "object" && typeof value.values === "function"
        ? [...value.values()]
        : value && typeof value === "object" ? Object.values(value) : [];

    const looksLikeCore = (state) => Boolean(state)
      && typeof state === "object"
      && (state.guildWeeklyTrialSet || state.guildCharacterMap || state.guildCharacterDict)
      && state.character;
    const scoreCore = (state) => CORE_KEYS.filter((key) => state[key] != null).length;

    function findCore() {
      const candidates = [];
      const roots = [document.querySelector('[class^="GamePage_gamePage"]'), document.getElementById("root"), document.body].filter(Boolean);
      const queue = roots.flatMap((root) => Reflect.ownKeys(root)
        .filter((key) => String(key).startsWith("__reactFiber$") || String(key).startsWith("__reactContainer$"))
        .map((key) => root[key]));
      const seen = new Set();
      for (let index = 0; index < queue.length && index < 8000; index += 1) {
        const fiber = queue[index];
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const node = fiber.stateNode;
        if (node && typeof node === "object" && typeof node.state === "object" && looksLikeCore(node.state)) candidates.push(node);
        if (fiber.return) queue.push(fiber.return);
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      candidates.sort((left, right) => scoreCore(right.state) - scoreCore(left.state));
      return candidates[0] ?? null;
    }

    function findHandler(core, pattern) {
      const found = Object.getOwnPropertyNames(core).find((name) => pattern.test(name) && typeof core[name] === "function");
      return found ?? Object.getOwnPropertyNames(Object.getPrototypeOf(core) ?? {})
        .find((name) => pattern.test(name) && typeof core[name] === "function") ?? "";
    }

    function abilityLevelsFromState(state) {
      const result = {};
      const character = state?.character ?? {};
      const scalarFields = {
        "/abilities/revive": "reviveLevel",
        "/abilities/insanity": "insanityLevel",
        "/abilities/guardian_aura": "guardianAuraLevel",
        "/abilities/speed_aura": "speedAuraLevel",
        "/abilities/fierce_aura": "fierceAuraLevel",
        "/abilities/critical_aura": "criticalAuraLevel",
        "/abilities/mystic_aura": "mysticAuraLevel",
        "/abilities/elemental_affinity": "elementalAffinityLevel",
        "/abilities/berserk": "berserkLevel",
        "/abilities/frenzy": "frenzyLevel",
      };
      for (const [abilityHrid, field] of Object.entries(scalarFields)) {
        const level = Number(character[field]);
        if (Number.isFinite(level) && level > 0) result[abilityHrid] = Math.trunc(level);
      }
      for (const row of values(state?.characterAbilityMap ?? state?.characterAbilities ?? state?.characterAbilityDict)) {
        const hrid = String(row?.abilityHrid ?? row?.hrid ?? "");
        const level = Number(row?.level);
        if (hrid.startsWith("/abilities/") && Number.isFinite(level) && level > 0) {
          result[hrid] = Math.max(result[hrid] ?? 0, Math.trunc(level));
        }
      }
      return result;
    }

    function emit(kind, payload) {
      try {
        window.postMessage({ source: channel, type: kind, payload }, window.location.origin);
      } catch { /* capture must never break the game */ }
    }

    let session = null;

    // Wire types the client uses for the two replies.
    const PROFILE_PACKET = "profile_shared";
    const LOADOUT_PACKET = "loadout_shared";

    /**
     * Wrap the two reply handlers so replies are captured without opening a modal.
     *
     * The client dispatches through `this.messageHandlers[type]`, a table built
     * once in the constructor that holds the *original* function references.
     * Replacing `core.handleMessageProfileShared` alone therefore never runs and
     * the modal still opens, so patch the table first and only fall back to the
     * named method when a release has no table.
     */
    function beginCapture() {
      const core = findCore();
      if (!core) return { core: null, restore: [], wrapped: false, via: "" };
      const restore = [];
      const wrap = (holder, key, kind) => {
        const original = holder[key];
        if (typeof original !== "function" || original.__aduduWrapped) return false;
        const wrapped = function aduduSilentSharedHandler(...args) {
          const event = args[0] ?? {};
          emit(kind, kind === "profile" ? event.profile : event.loadout);
          // Intentionally do not call the original: the game would open a modal.
        };
        wrapped.__aduduWrapped = true;
        wrapped.__aduduOriginal = original;
        holder[key] = wrapped;
        restore.push(() => {
          if (holder[key] === wrapped) holder[key] = original;
        });
        return true;
      };
      const table = core.messageHandlers && typeof core.messageHandlers === "object"
        ? core.messageHandlers : null;
      const named = (pattern) => findHandler(core, pattern);

      const wrapPacket = (packet, pattern, kind) => {
        if (table && wrap(table, packet, kind)) return `messageHandlers.${packet}`;
        const name = named(pattern);
        return name && wrap(core, name, kind) ? name : "";
      };

      const profileVia = wrapPacket(PROFILE_PACKET, PROFILE_HANDLER, "profile");
      const loadoutVia = wrapPacket(LOADOUT_PACKET, LOADOUT_HANDLER, "loadout");
      return {
        core,
        restore,
        wrapped: Boolean(profileVia || loadoutVia),
        via: profileVia || loadoutVia,
        profileName: profileVia,
        loadoutName: loadoutVia,
      };
    }

    /**
     * Fallback capture: if this client has no reply handler to wrap, read the
     * same replies straight off the game socket. The getter is read-only and
     * always returns the original payload.
     */
    function installSocketObserver() {
      if (window.__ADUDU_GUILD_COLLECT_WS__) return;
      try {
        const prototype = window.MessageEvent?.prototype;
        const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "data");
        if (!descriptor?.get || descriptor.configurable === false) return;
        const originalGet = descriptor.get;
        const seen = new WeakSet();
        Object.defineProperty(prototype, "data", {
          ...descriptor,
          get() {
            const message = originalGet.call(this);
            if (typeof message === "string" && !seen.has(this)
              && (message.includes('"profile_shared"') || message.includes('"loadout_shared"'))) {
              seen.add(this);
              queueMicrotask(() => {
                try {
                  const packet = JSON.parse(message);
                  if (packet?.type === "profile_shared") emit("profile", packet.profile);
                  else if (packet?.type === "loadout_shared") emit("loadout", packet.loadout);
                } catch { /* unrelated frame */ }
              });
            }
            return message;
          },
        });
        window.__ADUDU_GUILD_COLLECT_WS__ = true;
      } catch { /* socket hook unavailable; handler wrap is enough */ }
    }

    window.addEventListener("message", (event) => {
      if (event.origin !== window.location.origin || event.data?.source !== channel) return;
      const type = event.data?.type;
      if (type === "begin") {
        installSocketObserver();
        session = beginCapture();
        window.postMessage({
          source: channel,
          type: "ready",
          wrapped: session.wrapped,
          profileHandler: session.profileName ?? "",
          loadoutHandler: session.loadoutName ?? "",
          abilityLevels: session.core ? abilityLevelsFromState(session.core.state) : {},
        }, window.location.origin);
        return;
      }
      if (type === "end") {
        for (const undo of session?.restore ?? []) {
          try { undo(); } catch { /* already replaced */ }
        }
        session = null;
        window.postMessage({ source: channel, type: "ended" }, window.location.origin);
        return;
      }
      if (type === "request-profile") {
        const core = session?.core ?? findCore();
        const memberId = String(event.data.memberId ?? "");
        if (!core || !memberId) return;
        if (typeof core.handleViewProfile === "function") {
          try { core.handleViewProfile(memberId); return; } catch { /* try the socket */ }
        }
        const conn = core.state?.gameConn ?? core.gameConn;
        if (typeof conn?.sendViewProfile === "function") {
          try { conn.sendViewProfile(memberId); } catch { /* reported as timeout */ }
        }
        return;
      }
      if (type === "request-loadout") {
        const core = session?.core ?? findCore();
        const characterId = Number(event.data.characterId);
        const actionType = String(event.data.actionType ?? "guild_trial");
        const category = String(event.data.category ?? "combat");
        if (!core || !Number.isFinite(characterId)) return;
        if (typeof core.handleViewLoadout === "function") {
          try { core.handleViewLoadout(characterId, actionType, category); return; } catch { /* try the socket */ }
        }
        const conn = core.state?.gameConn ?? core.gameConn;
        if (typeof conn?.sendViewLoadout === "function") {
          try { conn.sendViewLoadout(characterId, actionType, category); } catch { /* reported as timeout */ }
        }
      }
    });

    window.postMessage({ source: channel, type: "ready", wrapped: false, abilityLevels: {} }, window.location.origin);
  }
  /* ------------------------- collection driver ------------------------- */

  const collectState = {
    running: false,
    paused: false,
    cancelled: false,
    // Every pending wait registers its timer and a wake callback so cancel can
    // resolve them instead of leaving promises hanging.
    timers: new Set(),
    wakers: new Set(),
    total: 0,
    index: 0,
    uploaded: 0,
    failed: 0,
    memberId: "",
    members: [],
    core: null,
    abilityLevels: {},
    profile: null,
    loadouts: {},
    installed: false,
    uploader: "",
    // `${guildSlug}:${memberId}` of the character the collector fields describe.
    scopeKey: "",
    // The two parts are tracked separately so that a guild merely becoming
    // known (cold start: "" -> "WI") is not mistaken for a character switch.
    scopeSlug: "",
    scopeMember: "",
    // Bumped on every real identity change, including leaving a character and
    // coming back to it: a name match alone cannot tell an in-flight sync of
    // the first visit from a fresh one after the round trip.
    scopeGeneration: 0,
    eligibilityInFlight: false,
    eligibilityMemberId: "",
    eligibilityCheckedAt: 0,
  };

  function installCollectBridge() {
    if (collectState.installed) return;
    collectState.installed = true;
    window.addEventListener("message", (event) => {
      if (event.origin !== location.origin || event.data?.source !== COLLECT_CHANNEL) return;
      const type = event.data?.type;
      if (type === "ready") {
        collectState.core = { ready: true };
        collectState.abilityLevels = collectCaptureAbilities(event.data.abilityLevels);
        return;
      }
      if (type === "profile") {
        // Only the member we are currently asking for may satisfy the wait.
        // A late reply for a previous member would otherwise be uploaded under
        // the current member's name, carrying that member's skills.
        const profile = collectNormalizeProfile(event.data.payload);
        if (!profile || !collectIsCurrentMember(profile.memberId)) return;
        collectState.profile = profile;
        return;
      }
      if (type === "loadout") {
        const payload = event.data.payload;
        if (!collectIsCurrentMember(collectLoadoutMemberId(payload))) return;
        const actionTypeHrid = String(payload?.actionTypeHrid ?? "");
        const key = actionTypeHrid.includes("combat") ? "combat"
          : actionTypeHrid.includes("skilling") ? "skilling" : "other";
        collectState.loadouts[key] = payload;
      }
    });
    const script = document.createElement("script");
    script.id = UI.collect;
    script.textContent = `;(${collectPageMain.toString()})(${JSON.stringify(COLLECT_CHANNEL)});`;
    document.documentElement.append(script);
    script.remove();
  }

  const collectCaptureAbilities = (value) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
    .flatMap(([hrid, level]) => {
      const number = Number(level);
      return String(hrid).startsWith("/abilities/") && Number.isFinite(number) && number > 0
        ? [[hrid, Math.trunc(number)]]
        : [];
    }));

  const collectMapEntries = (value) => value && typeof value === "object" && typeof value.entries === "function"
    ? [...value.entries()]
    : value && typeof value === "object" ? Object.entries(value) : [];

  /** `wearableItemMap` values are `charId::location::itemHrid::enhancement` or an item row. */
  function collectEquipmentFrom(value) {
    return collectMapEntries(value).flatMap(([locationHrid, raw]) => {
      if (!raw) return [];
      const row = raw && typeof raw === "object" ? raw : null;
      const parts = row ? [] : String(raw).split("::");
      const itemHrid = String(
        row?.itemHrid ?? row?.hrid
        ?? (parts.length >= 4 && String(parts[2]).startsWith("/items/") ? parts[2] : "")
        ?? (parts.find((part) => String(part).startsWith("/items/")) ?? "")
      );
      if (!itemHrid.startsWith("/items/")) return [];
      const enhancementLevel = Number(
        row?.enhancementLevel ?? row?.enhancement_level
        ?? (parts.length >= 4 ? parts[3] : undefined)
        ?? 0
      );
      return [{
        locationHrid: String(locationHrid),
        itemHrid,
        enhancementLevel: Number.isFinite(enhancementLevel) ? Math.max(0, Math.trunc(enhancementLevel)) : 0,
      }];
    });
  }

  /** Shared profiles use `wearableItemMap`; loadouts use `wearableMap`. */
  const collectText = (value) => typeof value === "string" ? value.trim()
    : (Number.isFinite(value) ? String(value) : "");

  /**
   * Shared replies carry the subject under `sharableCharacter`; the flat name
   * fields only appear in older releases.
   */
  function collectProfileMemberId(profile) {
    return collectText(
      profile?.sharableCharacter?.name
      ?? profile?.name ?? profile?.displayName ?? profile?.characterName,
    );
  }

  /** Loadouts identify their subject the same way as profiles. */
  function collectLoadoutMemberId(loadout) {
    return collectText(
      loadout?.sharableCharacter?.name
      ?? loadout?.characterName ?? loadout?.name ?? loadout?.memberId,
    );
  }

  /**
   * Gate replies on the member currently being collected. Unknown identity is
   * not trusted: an unlabelled reply could belong to anyone.
   */
  function collectIsCurrentMember(memberId) {
    const wanted = collectText(collectState.memberId);
    return Boolean(wanted) && collectText(memberId) === wanted;
  }

  function collectNormalizeProfile(profile) {
    if (!profile || typeof profile !== "object") return null;
    return {
      memberId: collectProfileMemberId(profile),
      skills: Object.fromEntries(values(profile.characterSkills).flatMap((row) => {
        const hrid = String(row?.skillHrid ?? row?.hrid ?? "");
        const level = Number(row?.level);
        return hrid.startsWith("/skills/") && Number.isFinite(level) ? [[hrid, Math.max(0, Math.trunc(level))]] : [];
      })),
      equipment: collectEquipmentFrom(profile.wearableItemMap ?? profile.equipment),
      abilities: values(profile.equippedAbilities ?? profile.abilityMap).flatMap((row, index) => {
        const abilityHrid = String(row?.abilityHrid ?? row?.hrid ?? row ?? "");
        if (!abilityHrid.startsWith("/abilities/")) return [];
        const slot = Number(row?.slotNumber ?? row?.slot);
        return [{
          slot: Number.isFinite(slot) ? Math.max(0, Math.trunc(slot) - 1) : index,
          abilityHrid,
          level: Math.max(1, Math.trunc(Number(row?.level) || 1)),
          triggers: values(
            profile.abilityCombatTriggersMap instanceof Map
              ? profile.abilityCombatTriggersMap.get(abilityHrid)
              : profile.abilityCombatTriggersMap?.[abilityHrid]
          ),
        }];
      }).slice(0, 5),
      characterHouseRoomMap: profile.characterHouseRoomMap,
      characterAchievements: profile.characterAchievements,
    };
  }

  /** Signup trials map onto the profession action type the life optimizer reads. */
  const COLLECT_SKILL_ACTION_TYPES = Object.freeze({
    "/guild_skilling/alchemy": "/action_types/alchemy",
    "/guild_skilling/brewing": "/action_types/brewing",
    "/guild_skilling/cheesesmithing": "/action_types/cheesesmithing",
    "/guild_skilling/cooking": "/action_types/cooking",
    "/guild_skilling/crafting": "/action_types/crafting",
    "/guild_skilling/enhancing": "/action_types/enhancing",
    "/guild_skilling/foraging": "/action_types/foraging",
    "/guild_skilling/milking": "/action_types/milking",
    "/guild_skilling/tailoring": "/action_types/tailoring",
    "/guild_skilling/woodcutting": "/action_types/woodcutting",
  });

  /** `wearableMap` values carry refinement as an `_refined` item suffix. */
  function collectLoadoutRecord(loadout, kind, trialHrid = "") {
    const equipment = collectEquipmentFrom(loadout?.wearableItemMap ?? loadout?.wearableMap ?? loadout?.equipment);
    const triggerMap = loadout?.abilityCombatTriggersMap ?? {};
    const abilities = values(loadout?.equippedAbilities ?? loadout?.abilityMap ?? loadout?.abilities).flatMap((row, index) => {
      const abilityHrid = String(
        typeof row === "object" ? row?.abilityHrid ?? row?.hrid ?? "" : row ?? ""
      );
      if (!abilityHrid.startsWith("/abilities/")) return [];
      const slot = Number(typeof row === "object" ? row?.slotNumber ?? row?.slot : undefined);
      return [{
        slot: Number.isFinite(slot) ? Math.max(0, Math.trunc(slot) - 1) : index,
        abilityHrid,
        level: Math.max(1, Math.trunc(Number(typeof row === "object" ? row?.level : 1) || 1)),
        triggers: values(triggerMap instanceof Map ? triggerMap.get(abilityHrid) : triggerMap[abilityHrid]),
      }];
    }).slice(0, 5);
    const skillActionType = COLLECT_SKILL_ACTION_TYPES[trialHrid] ?? "";
    return {
      loadoutId: `guild_trial:${kind}`,
      name: kind === "combat" ? tr("collectCombatLoadoutName") : tr("collectSkillingLoadoutName"),
      actionTypeHrid: kind === "combat"
        ? "/action_types/combat"
        : skillActionType || "/action_types/all",
      equipment,
      abilities: kind === "combat" ? abilities : [],
    };
  }

  function collectRosterMembers() {
    const sharable = state.guildSharableCharacterMap;
    const signupLevels = state.guildTrialSignupLevelMap;
    return entries(state.guildCharacterMap).flatMap(([mapKey, guildCharacter]) => {
      const playerId = Number(guildCharacter?.characterID ?? guildCharacter?.characterId ?? mapKey);
      if (!Number.isInteger(playerId) || playerId <= 0) return [];
      const shared = dictionaryValue(sharable, mapKey)
        ?? dictionaryValue(sharable, playerId)
        ?? dictionaryValue(sharable, String(playerId))
        ?? {};
      const memberId = String(shared?.name ?? guildCharacter?.name ?? guildCharacter?.characterName ?? "").trim();
      if (!memberId) return [];
      if (String(guildCharacter?.status ?? "joined").trim() !== "joined") return [];
      const levelRow = dictionaryValue(signupLevels, mapKey)
        ?? dictionaryValue(signupLevels, playerId)
        ?? dictionaryValue(signupLevels, String(playerId))
        ?? {};
      return [{
        playerId,
        memberId,
        combatTrialHrid: String(guildCharacter?.signedUpCombatTrialHrid ?? "").trim(),
        skillingTrialHrid: String(guildCharacter?.signedUpSkillingTrialHrid ?? "").trim(),
        combatLevel: Math.max(0, Math.trunc(Number(levelRow?.combatLevel) || 0)),
        skillingLevel: Math.max(0, Math.trunc(Number(levelRow?.skillingTrialLevel) || 0)),
      }];
    }).sort((left, right) => left.memberId.localeCompare(right.memberId));
  }

  function collectWait(ms) {
    return new Promise((resolve) => {
      let waited = 0;
      let timer = 0;
      const tick = 50;
      const finish = () => {
        clearTimeout(timer);
        collectState.timers.delete(timer);
        collectState.wakers.delete(finish);
        resolve();
      };
      const step = () => {
        collectState.timers.delete(timer);
        if (collectState.cancelled) return finish();
        waited += tick;
        if (waited >= ms) return finish();
        timer = setTimeout(step, tick);
        collectState.timers.add(timer);
      };
      if (collectState.cancelled) return resolve();
      collectState.wakers.add(finish);
      timer = setTimeout(step, tick);
      collectState.timers.add(timer);
    });
  }

  function collectWaitFor(read, timeoutMs) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let timer = 0;
      const settle = (value) => {
        clearTimeout(timer);
        collectState.timers.delete(timer);
        collectState.wakers.delete(wake);
        resolve(value);
      };
      const wake = () => settle(null);
      const poll = () => {
        collectState.timers.delete(timer);
        if (collectState.cancelled) return settle(null);
        const value = read();
        if (value) return settle(value);
        if (Date.now() - startedAt >= timeoutMs) return settle(null);
        timer = setTimeout(poll, 60);
        collectState.timers.add(timer);
      };
      if (collectState.cancelled) return resolve(null);
      collectState.wakers.add(wake);
      poll();
    });
  }

  function collectPace() {
    const span = COLLECT_MAX_INTERVAL_MS - COLLECT_MIN_INTERVAL_MS;
    return COLLECT_MIN_INTERVAL_MS + Math.round(Math.random() * span);
  }

  async function collectAwaitResume() {
    while (collectState.paused && !collectState.cancelled) {
      await collectWait(150);
    }
  }

  /**
   * Pause gate for every request we are about to send. Pausing mid-member must
   * stop the rest of that member's requests, not just the next member's.
   * Returns false when the run was cancelled while paused.
   */
  async function collectAwaitResumeOrCancel() {
    await collectAwaitResume();
    return !collectState.cancelled;
  }

  function collectPost(type, payload) {
    window.postMessage({ source: COLLECT_CHANNEL, type, ...payload }, location.origin);
  }

  /**
   * A reply only counts when the member actually has a loadout in it.
   * `hasLoadout === false` arrives as a perfectly good object, so truthiness
   * alone would let an empty signup through.
   */
  function collectUsableLoadoutPayload(payload) {
    if (!payload) return null;
    if (payload.hasLoadout === false) return null;
    const equipment = collectEquipmentFrom(payload.wearableItemMap ?? payload.wearableMap ?? payload.equipment);
    return equipment.length ? payload : null;
  }

  /** Wait predicate: the newest live reply for this kind, if it is usable. */
  function collectLiveLoadout(kind) {
    return collectUsableLoadoutPayload(collectState.loadouts[kind]);
  }

  /** Snapshot reader: only the reply frozen when its wait passed. */
  function collectUsableLoadout(captured, kind) {
    return collectUsableLoadoutPayload(captured?.loadouts?.[kind]);
  }

  function collectMemberSnapshot(member, captured) {
    // Read from the frozen capture, never from mutable collectState: a late
    // reply must not change what gets uploaded.
    const profile = captured?.profile ?? null;
    const combatPayload = collectUsableLoadout(captured, "combat");
    const skillingPayload = collectUsableLoadout(captured, "skilling");
    const combat = combatPayload ? collectLoadoutRecord(combatPayload, "combat") : null;
    const skilling = skillingPayload
      ? collectLoadoutRecord(skillingPayload, "skilling", member.skillingTrialHrid)
      : null;
    const worn = profile?.equipment?.length
      ? [{
        loadoutId: "guild_trial:worn",
        name: tr("collectWornLoadoutName"),
        actionTypeHrid: "/action_types/all",
        equipment: profile.equipment,
        abilities: profile.abilities,
      }]
      : [];
    const loadouts = [combat, skilling, ...worn].filter((loadout) => loadout && loadout.equipment.length);
    const authorizedEquipment = loadouts.flatMap((loadout) => loadout.equipment);
    // Only the target member's own replies may seed their abilities. The
    // collector's own levels live in collectState.abilityLevels and would
    // otherwise be written into every other member's snapshot.
    //
    // The profile only reports the five abilities worn right now, so a member
    // who signs up with a different set would lose every ability that appears
    // solely in their signup loadout — typically the aura they are expected to
    // bring. Seed from the signup loadouts too, but only for abilities the
    // member themselves put in a loadout, and never below what a reply says.
    const abilityLevels = new Map();
    const learnAbility = (abilityHrid, level) => {
      const hrid = String(abilityHrid ?? "");
      if (!hrid.startsWith("/abilities/")) return;
      const value = Math.max(1, Math.trunc(Number(level) || 1));
      abilityLevels.set(hrid, Math.max(abilityLevels.get(hrid) ?? 0, value));
    };
    for (const ability of profile?.abilities ?? []) learnAbility(ability.abilityHrid, ability.level);
    for (const loadout of loadouts) {
      for (const ability of loadout.abilities ?? []) learnAbility(ability.abilityHrid, ability.level);
    }
    const learnedAbilities = Object.fromEntries(abilityLevels);
    const api = builder();
    return api.buildMemberSnapshot({
      memberId: member.memberId,
      displayName: member.memberId,
      guildId: apiSlug() || undefined,
      character: { id: member.playerId, name: member.memberId },
      loadouts,
      authorizedEquipment,
      skills: profile?.skills ?? {},
      learnedAbilities,
      auras: Object.fromEntries(Object.entries(learnedAbilities).filter(([hrid]) => hrid.endsWith("_aura"))),
      characterHouseRoomMap: profile?.characterHouseRoomMap,
      characterAchievements: profile?.characterAchievements,
      guildBuildingLevelDict: state.guildBuildingLevelCaptured ? state.guildBuildingLevelDict : undefined,
      selectedLoadoutIds: [],
      source: "guild-roster-collect",
      sourceSchemaVersion: "mwi-guild-collect-v1",
      capturedAt: new Date().toISOString(),
    });
  }

  /** Retry a rate-limited upload instead of failing the member outright. */
  const COLLECT_RATE_LIMIT_RETRIES = 4;
  const COLLECT_RATE_LIMIT_BACKOFF_MS = 1000;

  async function collectPostSnapshot(member, snapshot) {
    // One collector uploads many members' snapshots, but the per-member route
    // only accepts that member's own secret. The batch route authorises with the
    // reporter's own token instead, which is exactly this situation.
    // A character switch clears the reporter identity (and cancels the run);
    // never post a batch without one.
    if (!collectState.uploader) return null;
    const send = () => requestJson({
      method: "POST",
      url: guildApiUrl("/batch-snapshots"),
      data: {
        reporter: { memberId: collectState.uploader },
        capturedAt: new Date().toISOString(),
        snapshots: [{ memberId: member.memberId, snapshot }],
      },
    });
    // Every batch upload sits behind the same pause gate as the requests that
    // feed it: a pause clicked before this call must hold the upload, and a
    // cancel must not send it at all.
    if (!await collectAwaitResumeOrCancel()) return null;
    let response = await send();
    for (let attempt = 0; attempt < COLLECT_RATE_LIMIT_RETRIES && response.status === 429; attempt += 1) {
      // Back off further each time, and stay responsive to pause and cancel
      // while waiting. Checking only `cancelled` here still fired the retry
      // mid-pause, so a paused collector kept hitting the rate-limited route.
      await collectWait(COLLECT_RATE_LIMIT_BACKOFF_MS * (attempt + 1));
      if (!await collectAwaitResumeOrCancel()) return null;
      response = await send();
    }
    return response;
  }

  async function collectUpload(member, captured) {
    const snapshot = collectMemberSnapshot(member, captured);
    if (catalogMissingUsableEquipment(snapshot)) {
      throw new Error(tr("waitingEquipmentManual"));
    }
    const response = await collectPostSnapshot(member, snapshot);
    if (!response) return null;
    if (response.status < 200 || response.status >= 300) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = JSON.parse(response.responseText);
        const code = body?.error?.code;
        detail = code === "snapshot_auth_required" || code === "member_auth_required"
          ? tr("tokenRejected")
          : body?.error?.message ?? detail;
      } catch { /* keep status */ }
      throw new Error(detail);
    }
    // A 200 can still reject this member individually.
    let rejected = null;
    try {
      const body = JSON.parse(response.responseText);
      rejected = (body?.failures ?? []).find((failure) => failure?.memberId === member.memberId) ?? null;
    } catch { /* accepted unless a failure says otherwise */ }
    if (rejected) throw new Error(rejected.message || rejected.code || `HTTP ${response.status}`);
    return snapshot;
  }

  async function collectMember(member) {
    collectState.profile = null;
    collectState.loadouts = {};
    collectPost("request-profile", { memberId: member.memberId });
    const profile = await collectWaitFor(() => collectState.profile, COLLECT_PROFILE_TIMEOUT_MS);
    if (!profile) throw new Error(tr("collectProfileTimeout", member.memberId));
    // Freeze what we accepted at the moment each wait passed. A later reply for
    // the same member (for example an empty `hasLoadout: false` arriving during
    // the pacing gap) must not overwrite it and quietly drop the signup loadout.
    const captured = { profile, loadouts: {} };
    // A member who signed up must ship that signup loadout. Uploading a
    // snapshot without it would silently overwrite a good capture with the
    // worn set only, so a missing or empty reply is a failure, not a partial
    // success. `hasLoadout === false` means the member has no such loadout.
    // Each request sits behind its own pause gate: a pause clicked while this
    // member's profile was in flight must not fire their loadout requests.
    if (member.combatTrialHrid) {
      await collectWait(collectPace());
      if (!await collectAwaitResumeOrCancel()) return null;
      collectPost("request-loadout", { characterId: member.playerId, memberId: member.memberId, actionType: "guild_trial", category: "combat" });
      const combat = await collectWaitFor(() => collectLiveLoadout("combat"), COLLECT_LOADOUT_TIMEOUT_MS);
      if (!combat) throw new Error(tr("collectLoadoutTimeout", member.memberId, "combat"));
      captured.loadouts.combat = combat;
    }
    if (member.skillingTrialHrid) {
      await collectWait(collectPace());
      if (!await collectAwaitResumeOrCancel()) return null;
      collectPost("request-loadout", { characterId: member.playerId, memberId: member.memberId, actionType: "guild_trial", category: "skilling" });
      const skilling = await collectWaitFor(() => collectLiveLoadout("skilling"), COLLECT_LOADOUT_TIMEOUT_MS);
      if (!skilling) throw new Error(tr("collectLoadoutTimeout", member.memberId, "skilling"));
      captured.loadouts.skilling = skilling;
    }
    await collectWait(collectPace());
    if (!await collectAwaitResumeOrCancel()) return null;
    return collectUpload(member, captured);
  }

  function setCollectProgress(message) {
    const node = document.getElementById(UI.collectProgress);
    if (!node) return;
    node.style.display = collectState.running || collectState.total ? "block" : "none";
    const label = node.querySelector("span");
    if (label) label.textContent = message;
    const bar = node.querySelector("[data-collect-bar]");
    if (bar) {
      const ratio = collectState.total ? Math.min(1, collectState.index / collectState.total) : 0;
      bar.style.width = `${Math.round(ratio * 100)}%`;
    }
  }

  function renderCollectControls() {
    const button = document.getElementById(UI.collectButton);
    const pause = document.getElementById(UI.collectPause);
    const cancel = document.getElementById("adudu-guild-collect-cancel");
    if (button) {
      button.hidden = !collectState.uploader;
      button.disabled = collectState.running;
      button.textContent = tr("collectAll");
    }
    if (pause) {
      pause.hidden = !collectState.running;
      pause.textContent = collectState.paused ? tr("collectResume") : tr("collectPause");
    }
    const tokenEdit = document.getElementById(UI.tokenEdit);
    if (tokenEdit) {
      tokenEdit.hidden = !collectState.uploader;
      tokenEdit.textContent = tr("tokenEdit");
    }
    // Nobody who is not a reporter keeps a credential field around, and the
    // field itself only exists while it is open.
    if (!collectState.uploader) closeReporterTokenField();
    if (cancel) cancel.hidden = !collectState.running;
  }

  async function collectWholeGuild() {
    if (collectState.running) return;
    if (!collectState.uploader) {
      setStatus(tr("collectNotReporter"), true);
      return;
    }
    // The roster may allow this character to report, but the guild-wide routes
    // still need its secret. Without one every batch upload would be a 401, so
    // stop before pinning the game handlers or sending anything at all.
    if (!memberToken()) {
      setStatus(tr("collectNeedsToken"), true);
      return;
    }
    hydrateFromGameCache();
    hydrateFromLiveGame();
    const members = collectRosterMembers();
    if (!members.length) {
      setStatus(tr("collectNoMembers"), true);
      return;
    }
    clearTimeout(automaticSync.timer);
    automaticSync.timer = 0;
    collectState.running = true;
    collectState.paused = false;
    collectState.cancelled = false;
    collectState.members = members;
    collectState.total = members.length;
    collectState.index = 0;
    collectState.uploaded = 0;
    collectState.failed = 0;
    renderCollectControls();
    installCollectBridge();
    try {
      collectPost("begin", {});
      await collectWaitFor(() => collectState.core, 2000);
      for (const member of members) {
        if (collectState.cancelled) break;
        await collectAwaitResume();
        if (collectState.cancelled) break;
        collectState.memberId = member.memberId;
        collectState.index += 1;
        setStatus(tr("collectProgress", collectState.index, collectState.total, member.memberId));
        setCollectProgress(tr("collectProgress", collectState.index, collectState.total, member.memberId));
        try {
          const snapshot = await collectMember(member);
          if (snapshot) collectState.uploaded += 1;
        } catch (error) {
          collectState.failed += 1;
          console.warn("[adudu-guild-trial-sync] collect failed", member.memberId, error?.message || error);
        }
      }
      if (collectState.cancelled) {
        setStatus(tr("collectCancelled", collectState.index, collectState.total), true);
      } else {
        setStatus(tr("collectDone", collectState.uploaded, collectState.failed, collectState.total));
      }
    } finally {
      // Always un-patch the game and drop pending waits, even if a step threw.
      for (const timer of [...collectState.timers]) clearTimeout(timer);
      collectState.timers.clear();
      collectState.wakers.clear();
      collectPost("end", {});
      collectState.running = false;
      collectState.paused = false;
      collectState.profile = null;
      collectState.loadouts = {};
      collectState.core = null;
      renderCollectControls();
      // A refresh during the run (page bridge packets, recordPacket) used to
      // arm the automatic own-snapshot sync straight away. Skipping the
      // schedule below did not disarm that timer, so a cancel still produced
      // an eligibility GET and a snapshot POST after the run ended. Drop any
      // timer armed during the run, then re-arm only for a normal finish.
      clearTimeout(automaticSync.timer);
      automaticSync.timer = 0;
      if (!collectState.cancelled) scheduleAutomaticUpload(1200);
    }
  }

  function toggleCollectPause() {
    if (!collectState.running) return;
    collectState.paused = !collectState.paused;
    if (collectState.paused) {
      setStatus(tr("collectPausedNow", collectState.index, collectState.total));
    } else {
      setStatus(tr("collectProgress", collectState.index, collectState.total, collectState.memberId));
    }
    renderCollectControls();
  }

  function cancelCollect() {
    if (!collectState.running) return;
    collectState.cancelled = true;
    collectState.paused = false;
    // Clearing a timer alone leaves its promise pending forever, so the run
    // never reaches its finally block and the game keeps patched handlers.
    // Wake every waiter so the loop can unwind and send `end`.
    for (const timer of [...collectState.timers]) clearTimeout(timer);
    collectState.timers.clear();
    for (const wake of [...collectState.wakers]) {
      try { wake(); } catch { /* a waiter must never block the cancel */ }
    }
    collectState.wakers.clear();
  }

  async function detectCollectorEligibility(memberId) {
    if (!memberId || !apiSlug()) return;
    if (collectState.eligibilityInFlight) return;
    if (collectState.eligibilityMemberId === memberId
      && Date.now() - collectState.eligibilityCheckedAt < COLLECT_ELIGIBILITY_CACHE_MS) return;
    collectState.eligibilityInFlight = true;
    collectState.eligibilityMemberId = memberId;
    try {
      const response = await requestJson({
        method: "GET",
        url: guildApiUrl(`/members/${encodeURIComponent(memberId)}/eligibility`),
      });
      if (response.status !== 200) return;
      const body = JSON.parse(response.responseText || "{}");
      // The reply belongs to the character that asked. A switch while it was in
      // flight cleared the collector state already; reviving the old answer
      // would show the previous character's reporter controls.
      if (detectedMemberId() !== memberId) return;
      collectState.uploader = body.rosterSyncAllowed === true ? memberId : "";
      renderCollectControls();
    } catch { /* panel simply stays without the collector button */ }
    finally {
      collectState.eligibilityInFlight = false;
      collectState.eligibilityCheckedAt = Date.now();
    }
  }

  async function upload({ automatic = false } = {}) {
    if (automaticSync.running) {
      if (automatic) scheduleAutomaticUpload(800);
      return;
    }
    clearTimeout(automaticSync.timer);
    automaticSync.timer = 0;
    const snapshot = payload();
    // Capture the identity generation before any wait. A switch (or a round
    // trip away and back) during the guild-confirmation / equipment waits must
    // abandon this run; capturing it later would miss exactly that window.
    const identityGeneration = collectState.scopeGeneration ?? 0;
    if (!snapshot.memberId || snapshot.memberId === "unknown-member") {
      setStatus(tr("waitingName"), true);
      return;
    }
    if (!confirmedGuild()) {
      setStatus(tr("notRegisteredGuildYet"), true);
      const ok = await ensureGuildConfirmed();
      if (!ok) {
        setStatus(tr("notRegisteredGuildDetail", guildConfirmDetail()), true);
        return;
      }
    }
    if (catalogMissingUsableEquipment(snapshot)) {
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
    // Switching character while a sync is in flight must abandon it: the
    // snapshot, the roster and the secret all belong to the character that
    // started the run. Without this guard the eligibility reply of the old
    // character restores its reporter panel, and later requests carry the new
    // character's secret under the old character's payload.
    // Capture the scope here, after the guild-confirmation and equipment
    // hydrations: those waits may legitimately resolve a guild that was not in
    // state yet, and that is not a character switch.
    const uploadScope = guildApiUrl("");
    // The generation changes on every real switch. Comparing names alone is not
    // enough: adiudiu -> ShrimpPaste -> adiudiu while this request is in flight
    // would match again and let the abandoned sync finish under the old data.
    const stillCurrentCharacter = () =>
      (typeof detectedMemberId !== "function" || detectedMemberId() === snapshot.memberId)
      && guildApiUrl("") === uploadScope
      && (collectState.scopeGeneration ?? 0) === identityGeneration;
    // No network call at all for an abandoned run: even the public eligibility
    // GET must not go out under the previous character's member id.
    if (!stillCurrentCharacter()) return;
    automaticSync.running = true;
    try {
      setStatus(tr("checkingEligibility", snapshot.memberId));
      const eligibility = await requestJson({
        method: "GET",
        url: guildApiUrl(`/members/${encodeURIComponent(snapshot.memberId)}/eligibility`),
      });
      // The character may have changed while eligibility was in flight. Its
      // answer describes the old character and must not revive its reporter
      // panel or drive further requests under the new character's secret.
      if (!stillCurrentCharacter()) return;
      const eligibilityBody = JSON.parse(eligibility.responseText || "{}");
      if (eligibility.status !== 200 || eligibilityBody.eligible !== true) {
        // An ineligible character must not keep a reporter panel or a cached
        // collector identity from an earlier check.
        collectState.uploader = "";
        renderCollectControls();
        setStatus(tr("notEligible", snapshot.memberId), true);
        return;
      }
      // The reporter controls answer to this character's membership, never to
      // a cached answer for the previous character.
      const reporterAllowed = eligibilityBody.rosterSyncAllowed === true;
      collectState.uploader = reporterAllowed ? snapshot.memberId : "";
      collectState.eligibilityMemberId = snapshot.memberId;
      collectState.eligibilityCheckedAt = Date.now();
      renderCollectControls();
      // Roster, weekly trials, signups and guild-wide collection still need the
      // reporter's own secret. Without one they are not attempted at all: three
      // anonymous 401s previously produced a misleading "not updated" report.
      const reporterToken = reporterAllowed ? memberToken() : "";
      const reporterPending = Boolean(roster || weeklyTrials || trialRegistrations);
      const reporterTokenMissing = reporterAllowed && !reporterToken && reporterPending;
      let rosterSummary = "";
      if (reporterAllowed && reporterToken && roster) {
        if (!stillCurrentCharacter()) return;
        setStatus(tr("syncingRoster", roster.members.length));
        const rosterResponse = await requestJson({
          method: "POST",
          url: guildApiUrl("/roster"),
          data: roster,
        });
        if (!stillCurrentCharacter()) return;
        if (rosterResponse.status >= 200 && rosterResponse.status < 300) {
          rosterSummary = tr("rosterOk", roster.members.length);
        } else if (rosterResponse.status !== 429) {
          rosterSummary = tr("rosterFailed", uploadFailureDetail(rosterResponse));
        }
      }
      let trialSummary = "";
      let weeklyTrialSummary = "";
      const weeklyMonsterPanelsComplete = weeklyTrials?.trials
        ?.filter((trial) => trial.kind === "combat")
        .every((trial) => trial.monsterHrids.length > 0 && trial.monsters.length === trial.monsterHrids.length);
      if (reporterAllowed && reporterToken && weeklyTrials && weeklyMonsterPanelsComplete) {
        if (!stillCurrentCharacter()) return;
        setStatus(tr("syncingWeeklyTrials"));
        const weeklyTrialResponse = await requestJson({
          method: "POST",
          url: guildApiUrl("/weekly-trials"),
          data: weeklyTrials,
        });
        if (!stillCurrentCharacter()) return;
        if (weeklyTrialResponse.status >= 200 && weeklyTrialResponse.status < 300) {
          weeklyTrialSummary = tr(
            "weeklyTrialsOk",
            weeklyTrials.weeklyTrialSet.skillHrids.length,
            weeklyTrials.weeklyTrialSet.combatHrids.length,
          );
        } else if (weeklyTrialResponse.status !== 429) {
          weeklyTrialSummary = tr("weeklyTrialsFailed", uploadFailureDetail(weeklyTrialResponse, { weekly: true }));
        }
      } else if (reporterAllowed && reporterToken && weeklyTrials) {
        weeklyTrialSummary = tr("waitingMonsters");
      }
      if (reporterAllowed && reporterToken && trialRegistrations) {
        if (!stillCurrentCharacter()) return;
        setStatus(tr("syncingSignups"));
        const trialResponse = await requestJson({
          method: "POST",
          url: guildApiUrl("/trial-registrations"),
          data: trialRegistrations,
        });
        if (!stillCurrentCharacter()) return;
        if (trialResponse.status >= 200 && trialResponse.status < 300) {
          trialSummary = tr(
            "signupsOk",
            trialRegistrations.trials
              .map((trial) => `${displayCombatTrialName(trial.trialHrid)} ${trial.registeredCount}`)
              .join(" / "),
          );
        } else if (trialResponse.status !== 429) {
          trialSummary = tr("signupsFailed", uploadFailureDetail(trialResponse));
        }
      }
      if (!stillCurrentCharacter()) return;
      setStatus(tr("syncingLoadouts"));
      const response = await requestJson({
        method: "POST",
        url: guildApiUrl(`/members/${encodeURIComponent(snapshot.memberId)}/snapshots`),
        data: snapshot,
      });
      if (!stillCurrentCharacter()) return;
      if (response.status < 200 || response.status >= 300) {
        let detail = `HTTP ${response.status}`;
        try {
          const apiError = JSON.parse(response.responseText)?.error;
          detail = apiError?.code === "snapshot_auth_required" || apiError?.code === "member_auth_required"
            ? tr("tokenRejected")
            : apiError?.code === "empty_loadout_catalog"
              ? tr("waitingEquipmentManual")
              : apiError?.message ?? detail;
        } catch { /* keep status */ }
        throw new Error(detail);
      }
      automaticSync.lastSignature = signature;
      setStatus(tr(
        "synced",
        `${reporterTokenMissing ? tr("reporterTokenMissing") : ""}${rosterSummary}${weeklyTrialSummary}${trialSummary}`,
        snapshot.loadoutCatalog.length,
        snapshot.memberId,
      ));
    } catch (error) {
      setStatus(tr("syncFailed", error.message), true);
    } finally {
      automaticSync.running = false;
    }
  }

  /**
   * Protected reporter routes answer an unusable secret with 401/403
   * `member_auth_required` (or `snapshot_auth_required`). Show the localized
   * "secret rejected" message instead of the raw English server error.
   */
  function uploadFailureDetail(response, { weekly = false } = {}) {
    let detail = `HTTP ${response.status}`;
    try {
      const error = JSON.parse(response.responseText)?.error;
      const code = error?.code;
      if ((response.status === 401 || response.status === 403)
        && (code === "member_auth_required" || code === "snapshot_auth_required")) {
        return tr("tokenRejected");
      }
      if (weekly && code === "incomplete_weekly_monsters") return tr("monstersIncomplete");
      if (error?.message) detail = error.message;
    } catch { /* keep status */ }
    return detail;
  }
  function scheduleAutomaticUpload(delay = 800) {
    // While a collection is running, an automatic sync would fire mid-run or
    // — if the run is cancelled first — after the cancel. The run re-arms its
    // own sync when it finishes normally, so a timer asked for during the run
    // (refresh from a page-bridge packet, token save, a queued retry) is
    // dropped here instead of being left for the collection to forget.
    if (collectState.running) return;
    if (automaticSync.suppressSchedule) return;
    clearTimeout(automaticSync.timer);
    automaticSync.timer = setTimeout(() => upload({ automatic: true }), delay);
  }
  function refresh() {
    resetCollectorIdentity(detectedMemberId());
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
    const guildLine = document.getElementById("adudu-guild-sync-guild");
    if (guildLine) guildLine.textContent = tr("guildLabel", apiSlug());
    const memberId = detectedMemberId();
    if (memberId && apiSlug() && memberId !== collectState.uploader) void detectCollectorEligibility(memberId);
    renderCollectControls();
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
    const guildLine = document.createElement("p");
    guildLine.id = "adudu-guild-sync-guild";
    guildLine.style.cssText = "margin:2px 0;color:#9fb4ee;font-size:12px";
    guildLine.textContent = tr("guildLabel", apiSlug());
    const intro = document.createElement("p");
    intro.style.margin = "6px 0";
    intro.textContent = tr("intro");
    const list = document.createElement("div");
    list.id = UI.list;
    const status = document.createElement("p");
    status.id = UI.status;
    status.style.cssText = "margin:7px 0;color:#c9d4ff";
    status.textContent = tr("waitingCharacter");
    const progress = document.createElement("div");
    progress.id = UI.collectProgress;
    progress.style.cssText = "display:none;margin:6px 0;font-size:12px;color:#c9d4ff";
    const progressBarTrack = document.createElement("div");
    progressBarTrack.style.cssText = "height:5px;border-radius:3px;background:#26314f;overflow:hidden;margin-top:4px";
    const progressBar = document.createElement("div");
    progressBar.dataset.collectBar = "true";
    progressBar.style.cssText = "height:100%;width:0;background:#4d8dff;transition:width .2s linear";
    progressBarTrack.append(progressBar);
    const progressText = document.createElement("span");
    progress.append(progressText, progressBarTrack);
    const actions = document.createElement("div");
    actions.id = UI.actions;
    actions.style.cssText = "display:flex;gap:5px;flex-wrap:wrap";
    const collectButton = actionButton(tr("collectAll"), () => void collectWholeGuild());
    collectButton.id = UI.collectButton;
    collectButton.hidden = true;
    const collectPause = actionButton(tr("collectPause"), toggleCollectPause);
    collectPause.id = UI.collectPause;
    collectPause.hidden = true;
    const collectCancel = actionButton(tr("collectCancel"), cancelCollect);
    collectCancel.id = "adudu-guild-collect-cancel";
    collectCancel.hidden = true;
    // Reporters get an entry point, not a field: the masked secret box is created
    // only when this button is pressed, and it is removed again on save or
    // cancel. Ordinary members never see it at all.
    const tokenEdit = actionButton(tr("tokenEdit"), () => openReporterTokenField());
    tokenEdit.id = UI.tokenEdit;
    tokenEdit.hidden = true;
    actions.append(
      actionButton(tr("syncNow"), () => upload()),
      actionButton(tr("exportBackup"), download),
      collectButton,
      collectPause,
      collectCancel,
      tokenEdit,
    );
    content.append(heading, guildLine, intro, list, status, progress, actions);

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
      // Collapsing hides the panel, so an open secret field has to go with it
      // rather than sit in a hidden subtree waiting for the password manager.
      if (collapsed) closeReporterTokenField();
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
    installCollectBridge();
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
      if (assignmentAttemptFresh(combatAssignmentState) && combatAssignmentState.document) {
        renderCombatAssignmentUi();
      } else if (!assignmentAttemptFresh(combatAssignmentState)) {
        scheduleCombatAssignmentRefresh();
      }
      if (assignmentAttemptFresh(lifeAssignmentState) && lifeAssignmentState.document) {
        renderLifeAssignmentUi();
      } else if (!assignmentAttemptFresh(lifeAssignmentState)) {
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
