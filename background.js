// background.js — MV3 service worker
// Single source of truth for X Developer Console usage state; drives the badge.
//
// Reads the same cookie-authenticated console APIs that power
// console.x.com/.../billing/credits and .../usage:
//   GET /api/me
//   GET /api/accounts/{id}/credits
//   GET /api/accounts/{id}/spend
//   GET /api/accounts/{id}/usage?interval=current
//   GET /api/accounts/{id}/usage?interval=30days&groupBy=eventType
//   GET /api/accounts/{id}/usage?interval=30days&groupBy=requestType
//   GET /api/credits/pricing
//
// Auth is the existing X session cookies on console.x.com (auth_token + ct0).
// Requests send credentials: "include" and x-csrf-token from the ct0 cookie.

const DEBUG = false;
const dbg = (...args) => { if (DEBUG) console.log("[X API Usage Tracker]", ...args); };

const CONSOLE_ORIGIN = "https://console.x.com";

const DEFAULT_STATE = {
  account: {
    id: null,
    name: null,
  },
  packageName: null, // e.g. "Pay Per Use"
  credits: {
    balanceUsd: null,
    freeBalanceUsd: null,
    freeExpiresAt: null,
  },
  spend: {
    usedUsd: null,
    limitUsd: null,
    remainingUsd: null,
    utilization: null,
    overLimit: null,
  },
  autoRecharge: {
    enabled: null, // threshold > 0
    thresholdUsd: null,
    status: null, // "on" | "off" | null
  },
  meters: [], // [{ key, label, used, limit, utilization }] — cap meters for badge
  analytics: {
    fromDate: null,
    toDate: null,
    totalCostUsd: null,
    totalPosts: null,
    totalUsers: null,
    totalRequests: null,
    events: [], // [{ key, label, used, costUsd, percentOfCap }]
  },
  billingCycleStart: null,
  billingCycleEnd: null,
  lastUpdated: null,
  lastErrorAt: null,
  lastError: null,
  errorCode: null, // 'no_session' | 'auth' | 'network' | 'unknown'
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function toEpoch(v) {
  if (!v) return null;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    // Unix seconds as string (account.createdAt style) vs ms
    const ms = n < 1e12 ? n * 1000 : n;
    return Number.isFinite(ms) ? ms : null;
  }
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function numOrNull(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Spend endpoint returns milli-dollars as integer strings (15015 → $15.015).
function milliToUsd(v) {
  const n = numOrNull(v);
  if (n == null) return null;
  return n / 1000;
}

function utilization(used, limit) {
  if (used == null || limit == null || !(limit > 0)) return null;
  return (used / limit) * 100;
}

// Match dashboard display rounding: fractional <0.5% still shows 1%.
function displayPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct <= 0) return 0;
  const rounded = Math.round(pct);
  return rounded === 0 ? 1 : Math.min(999, rounded);
}

// ─── Badge rendering ────────────────────────────────────────────────────────

const COLOR_GREEN = "#15803D";
const COLOR_AMBER = "#B45309";
const COLOR_RED = "#B91C1C";
const COLOR_GREY = "#3F3F46";
const BADGE_TEXT = "#FFFFFF";

// Icon: off-white disc, sharp black X, green progress ring.
const ICON_MARK = "#0A0A0A";
const ICON_BG = "#E1E4E8";
const ICON_TRACK = "rgba(10, 10, 10, 0.18)";
const ICON_RING = "#22c55e";

function computeBadge(state) {
  const candidates = [];
  if (state.spend?.utilization != null) candidates.push(state.spend.utilization);
  for (const m of state.meters || []) {
    if (m?.utilization != null) candidates.push(m.utilization);
  }

  // Out of credits is "how close to trouble" even without a spend %.
  const balance = state.credits?.balanceUsd;
  const freeBal = state.credits?.freeBalanceUsd ?? 0;
  const totalCredit = (balance ?? 0) + (freeBal ?? 0);
  const outOfCredits = balance != null && totalCredit <= 0;

  if (candidates.length === 0 && !outOfCredits) {
    if (state.lastError) {
      return {
        text: "!",
        color: COLOR_GREY,
        title: `X API Usage Tracker — ${state.lastError}`,
        fillPct: 0,
      };
    }
    return {
      text: "",
      color: COLOR_GREY,
      title: "X API Usage Tracker — no data yet",
      fillPct: 0,
    };
  }

  const worst = candidates.length ? Math.max(...candidates) : 100;
  const pct = displayPct(outOfCredits && candidates.length === 0 ? 100 : worst);
  // An empty balance blocks the API outright, so it outranks any percentage.
  const text = outOfCredits ? "$0" : `${pct}%`;

  let color;
  if (outOfCredits || state.spend?.overLimit) color = COLOR_RED;
  else if (worst >= 90) color = COLOR_RED;
  else if (worst >= 70) color = COLOR_AMBER;
  else color = COLOR_GREEN;

  const parts = [];
  if (state.packageName) parts.push(state.packageName);
  if (state.account?.name) parts.push(state.account.name);
  if (balance != null) {
    // Prepaid balance can dip below zero when paid usage overdraws it.
    parts.push(`Credits: ${balance < 0 ? "-" : ""}$${Math.abs(balance).toFixed(2)}`);
  }
  if (state.spend?.usedUsd != null && state.spend?.limitUsd != null) {
    const upct =
      state.spend.utilization != null
        ? ` (${displayPct(state.spend.utilization)}%)`
        : "";
    parts.push(
      `Spend: $${state.spend.usedUsd.toFixed(2)} / $${state.spend.limitUsd.toFixed(2)}${upct}`
    );
  } else if (state.spend?.usedUsd != null) {
    parts.push(`Spend: $${state.spend.usedUsd.toFixed(2)}`);
  }
  for (const m of state.meters || []) {
    if (m?.utilization != null) {
      parts.push(`${m.label}: ${displayPct(m.utilization)}%`);
    }
  }
  if (state.autoRecharge?.status === "on") parts.push("Auto-recharge: ON");
  else if (state.autoRecharge?.status === "off") parts.push("Auto-recharge: OFF");
  if (outOfCredits) parts.push("Out of credits");
  if (state.billingCycleEnd) {
    const diff = state.billingCycleEnd - Date.now();
    if (diff > 0) {
      const days = Math.ceil(diff / 86400000);
      if (days >= 2) parts.push(`Cycle ends in ${days}d`);
      else {
        const mins = Math.max(0, Math.round(diff / 60000));
        const hrs = Math.floor(mins / 60);
        const rm = mins % 60;
        parts.push(rm > 0 ? `Cycle ends in ${hrs}h ${rm}m` : `Cycle ends in ${hrs}h`);
      }
    }
  }
  if (state.lastError) parts.push(`Last refresh failed: ${state.lastError}`);

  return {
    text,
    color,
    title: parts.join(" · "),
    fillPct: Math.max(0, Math.min(100, outOfCredits && candidates.length === 0 ? 100 : worst)),
  };
}

// ─── Dynamic toolbar icon (filled X + progress ring) ────────────────────────

function paintIcon(ctx, size, fillPct) {
  const cx = size / 2;
  const cy = size / 2;
  ctx.clearRect(0, 0, size, size);

  // Off-white disc — matches popup ground so the orange X reads on Chrome toolbars.
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.48, 0, Math.PI * 2);
  ctx.fillStyle = ICON_BG;
  ctx.fill();

  const ringR = size * 0.38;
  const ringW = Math.max(2, size * 0.1);

  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = ICON_TRACK;
  ctx.lineWidth = ringW;
  ctx.lineCap = "round";
  ctx.stroke();

  const pct = Math.max(0, Math.min(100, fillPct || 0));
  if (pct > 0) {
    const start = -Math.PI / 2;
    const sweep = Math.max((pct / 100) * Math.PI * 2, 0.14);
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, start, start + sweep);
    ctx.strokeStyle = ICON_RING;
    ctx.lineWidth = ringW;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  // Brand X glyph — slightly smaller, corners gently filleted so it’s not a pixel-perfect logo.
  const markScale = size * 0.0225;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(markScale, markScale);
  ctx.translate(-12, -12);
  ctx.fillStyle = ICON_MARK;
  ctx.fill(buildRoundedXMark(0.95), "evenodd");
  ctx.restore();
}

/** Filleted brand-X path in 24×24 space (outer + cutout). */
function buildRoundedXMark(radius) {
  const OUTER = [
    [18.244, 2.25], [21.552, 2.25], [14.325, 10.51], [22.827, 21.75],
    [16.17, 21.75], [10.956, 14.933], [4.99, 21.75], [1.68, 21.75],
    [9.41, 12.915], [1.254, 2.25], [8.08, 2.25], [12.793, 8.481],
  ];
  const INNER = [
    [17.083, 19.77], [18.916, 19.77], [7.084, 4.126], [5.117, 4.126],
  ];
  const path = new Path2D();
  addFilletedPolygon(path, OUTER, radius);
  addFilletedPolygon(path, INNER, radius * 0.75);
  return path;
}

function addFilletedPolygon(path, pts, radius) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const nxt = pts[(i + 1) % n];
    const v1x = prev[0] - cur[0];
    const v1y = prev[1] - cur[1];
    const v2x = nxt[0] - cur[0];
    const v2y = nxt[1] - cur[1];
    const l1 = Math.hypot(v1x, v1y) || 1;
    const l2 = Math.hypot(v2x, v2y) || 1;
    const d1 = Math.min(radius, l1 * 0.4);
    const d2 = Math.min(radius, l2 * 0.4);
    const p1x = cur[0] + (v1x / l1) * d1;
    const p1y = cur[1] + (v1y / l1) * d1;
    const p2x = cur[0] + (v2x / l2) * d2;
    const p2y = cur[1] + (v2y / l2) * d2;
    if (i === 0) path.moveTo(p1x, p1y);
    else path.lineTo(p1x, p1y);
    path.quadraticCurveTo(cur[0], cur[1], p2x, p2y);
  }
  path.closePath();
}

function drawIconBitmap(size, fillPct) {
  const scale = 4;
  const big = size * scale;
  const hi = new OffscreenCanvas(big, big);
  const hctx = hi.getContext("2d");
  hctx.imageSmoothingEnabled = true;
  hctx.imageSmoothingQuality = "high";
  paintIcon(hctx, big, fillPct);

  const lo = new OffscreenCanvas(size, size);
  const lctx = lo.getContext("2d");
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = "high";
  lctx.clearRect(0, 0, size, size);
  lctx.drawImage(hi, 0, 0, big, big, 0, 0, size, size);
  return lctx.getImageData(0, 0, size, size);
}

async function setProgressIcon(fillPct) {
  try {
    const images = {
      16: drawIconBitmap(16, fillPct),
      32: drawIconBitmap(32, fillPct),
    };
    await chrome.action.setIcon({ imageData: images });
  } catch (e) {
    dbg("setProgressIcon failed:", e);
  }
}

async function refreshBadge() {
  const { usageState } = await chrome.storage.local.get("usageState");
  const state = usageState || DEFAULT_STATE;
  const { text, color, title, fillPct } = computeBadge(state);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  try {
    await chrome.action.setBadgeTextColor({ color: BADGE_TEXT });
  } catch {
    // Older Chrome — auto text color is the graceful fallback.
  }
  await chrome.action.setTitle({ title });
  await setProgressIcon(fillPct ?? 0);
}

// ─── State writes (serialized) ──────────────────────────────────────────────

let writeQueue = Promise.resolve();

function mergeState(partial) {
  writeQueue = writeQueue
    .then(async () => {
      const { usageState } = await chrome.storage.local.get("usageState");
      const prev = usageState || DEFAULT_STATE;
      const next = {
        ...prev,
        ...partial,
        account: {
          ...DEFAULT_STATE.account,
          ...(prev.account || {}),
          ...(partial.account || {}),
        },
        credits: {
          ...DEFAULT_STATE.credits,
          ...(prev.credits || {}),
          ...(partial.credits || {}),
        },
        spend: {
          ...DEFAULT_STATE.spend,
          ...(prev.spend || {}),
          ...(partial.spend || {}),
        },
        autoRecharge: {
          ...DEFAULT_STATE.autoRecharge,
          ...(prev.autoRecharge || {}),
          ...(partial.autoRecharge || {}),
        },
        analytics: {
          ...DEFAULT_STATE.analytics,
          ...(prev.analytics || {}),
          ...(partial.analytics || {}),
          events:
            partial.analytics?.events !== undefined
              ? partial.analytics.events
              : (prev.analytics && prev.analytics.events) || [],
        },
        meters: partial.meters !== undefined ? partial.meters : prev.meters || [],
      };
      await chrome.storage.local.set({ usageState: next });
      await refreshBadge();
    })
    .catch((e) => dbg("mergeState error:", e));
  return writeQueue;
}

// ─── Auth / API ─────────────────────────────────────────────────────────────

async function getCookie(name) {
  try {
    const cookie = await chrome.cookies.get({
      name,
      url: CONSOLE_ORIGIN,
    });
    return cookie?.value || null;
  } catch {
    return null;
  }
}

async function hasSessionCookie() {
  const auth = await getCookie("auth_token");
  if (auth) return true;
  // Fallback signals used by the console itself.
  const twid = await getCookie("twid");
  const ct0 = await getCookie("ct0");
  return !!(twid && ct0);
}

class ApiError extends Error {
  constructor(status, endpoint) {
    super(`API ${status}: ${endpoint}`);
    this.name = "ApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

async function apiGet(endpoint) {
  const ct0 = await getCookie("ct0");
  const headers = { Accept: "application/json" };
  if (ct0) headers["x-csrf-token"] = ct0;

  const resp = await fetch(`${CONSOLE_ORIGIN}${endpoint}`, {
    method: "GET",
    credentials: "include",
    headers,
  });
  if (!resp.ok) {
    // Twitter-style auth failures often arrive as HTTP 400 + code 215.
    let status = resp.status;
    try {
      const body = await resp.json();
      const code = body?.errors?.[0]?.code;
      if (code === 215 || /bad authentication/i.test(body?.errors?.[0]?.message || "")) {
        status = 401;
      }
    } catch {
      // ignore parse failures; throw with original status
    }
    throw new ApiError(status, endpoint);
  }
  try {
    return await resp.json();
  } catch {
    throw new ApiError(0, endpoint);
  }
}

// ─── Throttle ───────────────────────────────────────────────────────────────

async function getThrottle() {
  try {
    const { throttle } = await chrome.storage.session.get("throttle");
    return throttle || {};
  } catch {
    return {};
  }
}

async function patchThrottle(partial) {
  try {
    const prev = await getThrottle();
    await chrome.storage.session.set({ throttle: { ...prev, ...partial } });
  } catch {
    // best-effort
  }
}

// ─── Parse console payloads ─────────────────────────────────────────────────

const EVENT_LABELS = {
  Post: "Posts",
  User: "Users",
  DirectMessage: "DMs",
  List: "Lists",
  Community: "Communities",
  Space: "Spaces",
  ProfileUpdate: "Profile updates",
  Like: "Likes",
  Follow: "Follows",
  Mute: "Mutes",
  Block: "Blocks",
  OwnedRead: "Owned reads",
  News: "News",
  Note: "Notes",
  Bookmark: "Bookmarks",
  Trend: "Trends",
};

// X keeps adding billable types. Unknown keys get a readable label
// ("PostCreateWithUrl" → "Post create with url") instead of the raw key.
function eventLabel(key) {
  if (EVENT_LABELS[key]) return EVENT_LABELS[key];
  const words = String(key)
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : String(key);
}

function parseEventGroups(groupedPayload, pricing) {
  const products = groupedPayload?.usage || {};
  const priceMap = pricing?.eventTypePricing || {};
  const events = [];
  let sharedCap = null;

  for (const productId of Object.keys(products)) {
    const product = products[productId] || {};
    const groups = product.groups || {};
    const cap = numOrNull(product.cap);
    if (cap != null && cap > 0) sharedCap = cap;

    for (const [key, g] of Object.entries(groups)) {
      const used = numOrNull(g?.usage) ?? 0;
      const unitPrice = numOrNull(priceMap[key]);
      const costUsd = unitPrice != null ? used * unitPrice : null;
      // API percentOfCap is already in percent units (0.148 → 0.148%).
      let pct = numOrNull(g?.percentOfCap);
      if (pct == null) pct = utilization(used, cap);
      events.push({
        key,
        label: eventLabel(key),
        used,
        costUsd,
        percentOfCap: pct,
        limit: cap != null && cap > 0 ? cap : null,
      });
    }
  }

  events.sort((a, b) => (b.used || 0) - (a.used || 0));
  return { events, sharedCap };
}

function parseUsageMetersFromEvents(events) {
  // The pay-per-use cap is on Post reads only, so Posts is the one capped
  // meter. Other event types are counted in the breakdown, not against the cap.
  const meters = [];
  const ev = events.find((e) => e.key === "Post");
  if (ev) {
    meters.push({
      key: "posts",
      label: "Post reads",
      used: ev.used,
      limit: ev.limit,
      utilization: utilization(ev.used, ev.limit),
    });
  }
  return meters;
}

function sumRequestGroups(groupedPayload) {
  const products = groupedPayload?.usage || {};
  let total = 0;
  let any = false;
  for (const productId of Object.keys(products)) {
    const groups = products[productId]?.groups || {};
    for (const g of Object.values(groups)) {
      const n = numOrNull(g?.usage);
      if (n != null) {
        total += n;
        any = true;
      }
    }
  }
  return any ? total : null;
}

function parseConsoleData({ me, credits, spend, eventUsage, requestUsage, pricing }) {
  const account = me?.account || {};
  const billing = account.billingRange?.current || {};
  const cycleStart = toEpoch(billing.start);
  const cycleEnd = toEpoch(billing.end);

  const paidBal = numOrNull(credits?.credits?.balance);
  const freeBal = numOrNull(credits?.freeCredits?.balance);
  const freeExp = toEpoch(credits?.freeCredits?.expiresAtMs);
  // expiresAtMs "0" means none
  const freeExpiresAt =
    freeExp && freeExp > 0 ? freeExp : null;

  const capUsd = numOrNull(credits?.settings?.billingCycleSpendCap);
  const thresholdUsd = numOrNull(credits?.settings?.autoRechargeThreshold);
  const autoOn = thresholdUsd != null && thresholdUsd > 0;

  const usedUsd = milliToUsd(spend?.totalSpend);
  const spendUtil = utilization(usedUsd, capUsd);
  const overLimit =
    usedUsd != null && capUsd != null && capUsd > 0 && usedUsd > capUsd;
  const remainingUsd =
    usedUsd != null && capUsd != null ? Math.max(0, capUsd - usedUsd) : null;

  // Package name from enrollments isn't always on /me; projects fill it later.
  let packageName = null;
  const resources = me?.resources || [];
  if (resources.some((r) => r?.name === "dev-portal-pay-per-use")) {
    packageName = "Pay Per Use";
  }

  const { events } = parseEventGroups(eventUsage, pricing);
  const meters = parseUsageMetersFromEvents(events);
  const postEv = events.find((e) => e.key === "Post");
  const userEv = events.find((e) => e.key === "User");
  const totalRequests = sumRequestGroups(requestUsage);

  return {
    account: {
      id: account.id || null,
      name: account.name || null,
    },
    packageName,
    credits: {
      balanceUsd: paidBal,
      freeBalanceUsd: freeBal,
      freeExpiresAt,
    },
    spend: {
      usedUsd,
      limitUsd: capUsd != null && capUsd > 0 ? capUsd : null,
      remainingUsd: capUsd != null && capUsd > 0 ? remainingUsd : null,
      utilization: spendUtil,
      overLimit,
    },
    autoRecharge: {
      enabled: thresholdUsd == null ? null : autoOn,
      thresholdUsd,
      status: thresholdUsd == null ? null : autoOn ? "on" : "off",
    },
    meters,
    analytics: {
      fromDate: eventUsage?.fromDate || null,
      toDate: eventUsage?.toDate || null,
      totalCostUsd: usedUsd,
      totalPosts: postEv?.used ?? null,
      totalUsers: userEv?.used ?? null,
      totalRequests,
      events,
    },
    billingCycleStart: cycleStart,
    billingCycleEnd: cycleEnd,
  };
}

function hasUsableData(parsed) {
  return !!(
    parsed.credits?.balanceUsd != null ||
    parsed.spend?.usedUsd != null ||
    (parsed.meters || []).some((m) => m?.utilization != null || m?.used != null) ||
    (parsed.analytics?.events || []).some((e) => e?.used > 0)
  );
}

// ─── Main fetch cycle ───────────────────────────────────────────────────────

let inFlight = null;

function fetchUsageAndUpdate(force = false) {
  if (inFlight) return inFlight;
  inFlight = doFetchUsage(force).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doFetchUsage(force = false) {
  if (!force) {
    const { backoffUntil = 0 } = await getThrottle();
    if (Date.now() < backoffUntil) return;
  }

  try {
    const signedIn = await hasSessionCookie();
    if (!signedIn) {
      await mergeState({
        lastError: "Not signed in to the X Developer Console.",
        errorCode: "no_session",
        lastErrorAt: Date.now(),
      });
      return;
    }

    const me = await apiGet("/api/me");
    const accountId = me?.account?.id;
    if (!accountId) {
      await mergeState({
        lastError: "No developer account found. Finish console onboarding.",
        errorCode: "unknown",
        lastErrorAt: Date.now(),
      });
      return;
    }

    const [credits, spend, eventUsage, requestUsage, pricing] = await Promise.all([
      apiGet(`/api/accounts/${accountId}/credits`),
      apiGet(`/api/accounts/${accountId}/spend`).catch((e) => {
        dbg("spend failed:", e);
        return null;
      }),
      apiGet(
        `/api/accounts/${accountId}/usage?interval=30days&groupBy=eventType`
      ).catch((e) => {
        dbg("event usage failed:", e);
        return null;
      }),
      apiGet(
        `/api/accounts/${accountId}/usage?interval=30days&groupBy=requestType`
      ).catch((e) => {
        dbg("request usage failed:", e);
        return null;
      }),
      apiGet(`/api/credits/pricing`).catch((e) => {
        dbg("pricing failed:", e);
        return null;
      }),
    ]);

    // Optional package label from projects.
    let packageName = null;
    try {
      const projects = await apiGet(`/api/accounts/${accountId}/projects`);
      const first = projects?.projects?.[0];
      if (first?.packageName) packageName = first.packageName;
    } catch (e) {
      dbg("projects failed:", e);
    }

    dbg("me/credits/spend/events:", { me, credits, spend, eventUsage, requestUsage });

    const parsed = parseConsoleData({
      me,
      credits,
      spend,
      eventUsage,
      requestUsage,
      pricing,
    });
    if (packageName) parsed.packageName = packageName;

    if (!hasUsableData(parsed)) {
      await mergeState({
        ...parsed,
        lastError: "Console APIs returned no credit/spend data.",
        errorCode: "unknown",
        lastErrorAt: Date.now(),
      });
      return;
    }

    await patchThrottle({ backoffUntil: 0 });
    await mergeState({
      ...parsed,
      lastUpdated: Date.now(),
      lastError: null,
      errorCode: null,
    });
  } catch (err) {
    console.error("[X API Usage Tracker] fetch error:", err);
    let errorCode = "unknown";
    let lastError = err.message || "Failed to fetch usage";
    if (err instanceof ApiError) {
      if (err.status === 401 || err.status === 403 || err.status === 215) {
        errorCode = "auth";
        lastError = "X session expired or unauthorized.";
      } else if (err.status === 404) {
        errorCode = "unknown";
        lastError = "Console usage API not found — the API may have changed.";
      } else if (err.status === 429) {
        errorCode = "network";
        lastError = "Rate limited by console.x.com — backing off.";
        await patchThrottle({ backoffUntil: Date.now() + 5 * 60_000 });
      } else if (err.status === 0) {
        errorCode = "network";
        lastError = "Unexpected non-JSON response from console.x.com.";
      } else if (err.status === 400) {
        // Bad Authentication data (Twitter code 215) sometimes surfaces as 400.
        errorCode = "auth";
        lastError = "X session expired or unauthorized.";
      } else {
        errorCode = "network";
      }
    } else if (err instanceof TypeError) {
      errorCode = "network";
      lastError = "Network error reaching console.x.com.";
    }
    await mergeState({ lastError, errorCode, lastErrorAt: Date.now() });
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.storage.local.set({ usageState: DEFAULT_STATE });
  } else {
    const { usageState } = await chrome.storage.local.get("usageState");
    await chrome.storage.local.set({
      usageState: {
        ...DEFAULT_STATE,
        ...(usageState || {}),
        account: {
          ...DEFAULT_STATE.account,
          ...((usageState && usageState.account) || {}),
        },
        credits: {
          ...DEFAULT_STATE.credits,
          ...((usageState && usageState.credits) || {}),
        },
        spend: {
          ...DEFAULT_STATE.spend,
          ...((usageState && usageState.spend) || {}),
        },
        autoRecharge: {
          ...DEFAULT_STATE.autoRecharge,
          ...((usageState && usageState.autoRecharge) || {}),
        },
        analytics: {
          ...DEFAULT_STATE.analytics,
          ...((usageState && usageState.analytics) || {}),
          events: (usageState && usageState.analytics && usageState.analytics.events) || [],
        },
        meters: (usageState && usageState.meters) || [],
      },
    });
  }
  await refreshBadge();
  fetchUsageAndUpdate();
});

refreshBadge().catch(() => {});

chrome.alarms.get("refreshUsage").then((existing) => {
  if (!existing) chrome.alarms.create("refreshUsage", { periodInMinutes: 3 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshUsage") fetchUsageAndUpdate();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "GET_USAGE_STATE") {
    chrome.storage.local
      .get("usageState")
      .then(({ usageState }) => sendResponse(usageState || DEFAULT_STATE))
      .catch(() => sendResponse(DEFAULT_STATE));
    return true;
  }
  if (msg?.type === "FORCE_REFRESH" || msg?.type === "X_USAGE_UPDATE") {
    fetchUsageAndUpdate(true)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});
