// popup.js — Reads UsageState from storage and renders the popup UI.

const DEFAULT_STATE = {
  account: {
    id: null,
    name: null,
  },
  packageName: null,
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
    enabled: null,
    thresholdUsd: null,
    status: null,
  },
  meters: [],
  analytics: {
    fromDate: null,
    toDate: null,
    totalCostUsd: null,
    totalPosts: null,
    totalUsers: null,
    totalRequests: null,
    events: [],
  },
  billingCycleStart: null,
  billingCycleEnd: null,
  lastUpdated: null,
  lastErrorAt: null,
  lastError: null,
  errorCode: null,
};

const CONSOLE_CREDITS_URL = "https://console.x.com";

const ERROR_COPY = {
  no_session: {
    title: "Sign in to X Console",
    body:
      "We couldn't find an X Developer Console session. To load your usage data:<ol>" +
      "<li>Open <strong>console.x.com</strong> and sign in</li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
  auth: {
    title: "X session expired",
    body:
      "Your X session has expired or isn't authorized. To reconnect:<ol>" +
      "<li>Open <strong>console.x.com</strong> and sign in if prompted</li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
  network: {
    title: "Can't reach console.x.com",
    body:
      "We hit a network error fetching your usage. To retry:<ol>" +
      "<li>Open <strong>console.x.com</strong> to confirm you're online</li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
  unknown: {
    title: "Couldn't load usage",
    body:
      "Something went wrong reading your usage. To retry:<ol>" +
      "<li>Open <strong>console.x.com</strong></li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
};

function barColor(pct) {
  if (pct >= 90) return "var(--red)";
  if (pct >= 70) return "var(--amber)";
  return "var(--green)";
}

function displayPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct <= 0) return 0;
  const rounded = Math.round(pct);
  return rounded === 0 ? 1 : Math.min(999, rounded);
}

function formatPct(pct) {
  const n = displayPct(pct);
  if (n == null) return "—";
  return `${n}%`;
}

function formatResetTime(ts) {
  if (!ts) return "";
  const diff = ts - Date.now();
  if (diff <= 0) return "Ends soon";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `Ends in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) {
    const rm = mins % 60;
    return rm > 0 ? `Ends in ${hrs}h ${rm}m` : `Ends in ${hrs}h`;
  }
  const days = Math.max(1, Math.ceil(diff / 86400000));
  return `Ends in ${days}d`;
}

function formatCycleDate(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return "";
  }
}

function formatLastUpdated(ts) {
  if (!ts) return "No data yet";
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins <= 0) return "Just now";
  if (mins === 1) return "1m ago";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function formatCompact(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(2)}K`;
  return String(Math.round(n));
}

function consoleUrl(state) {
  if (state.account?.id) {
    return `https://console.x.com/accounts/${state.account.id}/billing/credits`;
  }
  return CONSOLE_CREDITS_URL;
}

function buildBarSection({ label, valueText, pct, resetsAt, overLimit }) {
  const fillPct = pct != null ? Math.min(100, pct) : 0;

  const section = document.createElement("div");
  section.className = "section";
  section.innerHTML = `
    <div class="label-row">
      <span class="label"></span>
      <span class="value"></span>
    </div>
    <div class="bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100">
      <div class="bar-fill"></div>
    </div>
    <div class="reset-time"></div>
  `;
  section.querySelector(".label").textContent = label;
  const valueEl = section.querySelector(".value");
  valueEl.textContent = valueText;
  if (overLimit) valueEl.style.color = "var(--red)";

  const track = section.querySelector(".bar-track");
  track.setAttribute("aria-label", label);
  if (pct != null) {
    track.setAttribute("aria-valuenow", String(Math.round(Math.min(100, pct))));
    if (overLimit) track.setAttribute("aria-valuetext", valueText + " — over limit");
  } else {
    track.setAttribute("aria-valuetext", "No data");
  }

  const fill = section.querySelector(".bar-fill");
  fill.style.width = `${fillPct}%`;
  fill.style.backgroundColor = pct != null ? barColor(pct) : "var(--surface)";
  section.querySelector(".reset-time").textContent = formatResetTime(resetsAt);

  return section;
}

function hasData(state) {
  return !!(
    state.credits?.balanceUsd != null ||
    state.spend?.usedUsd != null ||
    (state.meters || []).some((m) => m?.used != null || m?.utilization != null) ||
    (state.analytics?.events || []).some((e) => e?.used > 0)
  );
}

function formatUsd(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function render(state) {
  const $ = (id) => document.getElementById(id);

  const hasErrorCode = !!state.errorCode;
  const showPrompt = hasErrorCode && !hasData(state);

  const promptEl = $("error-prompt");
  if (showPrompt) {
    const copy = ERROR_COPY[state.errorCode] || ERROR_COPY.unknown;
    $("error-prompt-title").textContent = copy.title;
    $("error-prompt-body").innerHTML = copy.body;
    promptEl.style.display = "";
  } else {
    promptEl.style.display = "none";
  }

  const errorEl = $("error-label");
  if (state.lastError && !showPrompt) {
    errorEl.textContent = `Last refresh failed: ${state.lastError}`;
    errorEl.style.display = "block";
  } else {
    errorEl.style.display = "none";
  }

  const tierEl = $("tier-pill");
  tierEl.textContent = state.packageName || "—";
  tierEl.title = state.packageName
    ? "Detected console package"
    : "Package not detected yet — open console.x.com and refresh";

  const cycleEl = $("cycle-banner");
  if (state.billingCycleEnd && !showPrompt) {
    const dateStr = formatCycleDate(state.billingCycleEnd);
    const countdown = formatResetTime(state.billingCycleEnd);
    cycleEl.innerHTML = dateStr
      ? `Billing cycle ends <strong>${dateStr}</strong><span class="countdown">${countdown}</span>`
      : `<span class="countdown">${countdown}</span>`;
    cycleEl.style.display = "";
  } else {
    cycleEl.style.display = "none";
  }

  // Credits card
  const credits = state.credits || {};
  const creditsSection = $("credits-section");
  const creditsHeading = $("credits-heading");
  if (!showPrompt && credits.balanceUsd != null) {
    creditsHeading.style.display = "";
    creditsSection.style.display = "";
    const free = credits.freeBalanceUsd || 0;
    const paid = credits.balanceUsd;
    const total = paid + free;
    const pill = $("credits-pill");
    pill.classList.remove("pill-on", "pill-off", "pill-neutral", "pill-paused");
    if (total <= 0) {
      pill.textContent = "EMPTY";
      pill.classList.add("pill-paused");
    } else {
      pill.textContent = "OK";
      pill.classList.add("pill-on");
    }
    let html = `<strong>$${paid.toFixed(2)}</strong> prepaid`;
    if (free > 0) {
      html += `<div class="extra-sub">$${free.toFixed(2)} free credits`;
      if (credits.freeExpiresAt) {
        html += ` · exp ${formatCycleDate(credits.freeExpiresAt)}`;
      }
      html += `</div>`;
    }
    if (total <= 0) {
      html += `<div class="extra-note">Out of credits — API requests blocked</div>`;
    }
    $("credits-detail").innerHTML = html;
  } else if (!showPrompt) {
    creditsHeading.style.display = "none";
    creditsSection.style.display = "none";
  } else {
    creditsHeading.style.display = "none";
    creditsSection.style.display = "none";
  }

  // Spend card
  const spend = state.spend || {};
  const ar = state.autoRecharge || {};
  const spendSection = $("spend-section");
  const spendHeading = $("spend-heading");
  const spendHorizon = $("spend-horizon");
  const overLimit = spend.overLimit === true;

  if (!showPrompt && (spend.usedUsd != null || spend.limitUsd != null || ar.status != null)) {
    spendHeading.style.display = "";
    spendSection.style.display = "";
    if (spendHorizon) spendHorizon.style.display = "";
    spendSection.classList.toggle("over-limit", overLimit);

    const arPill = $("autorecharge-pill");
    arPill.classList.remove("pill-on", "pill-off", "pill-neutral", "pill-paused");
    if (ar.status === "on") {
      arPill.textContent = "AUTO ON";
      arPill.classList.add("pill-on");
    } else if (ar.status === "off") {
      arPill.textContent = "AUTO OFF";
      arPill.classList.add("pill-off");
    } else {
      arPill.textContent = "—";
      arPill.classList.add("pill-neutral");
    }

    const detail = $("spend-detail");
    const barWrap = $("spend-bar-wrap");
    const bar = $("spend-bar");
    const barTrack = $("spend-bar-track");
    const resetEl = $("spend-reset");

    if (spend.usedUsd != null && spend.limitUsd != null && spend.limitUsd > 0) {
      const uPct = displayPct(spend.utilization);
      const pctTag =
        uPct != null
          ? ` · <span class="${overLimit ? "over" : ""}">${uPct}%</span>`
          : "";
      let html = `<strong>$${spend.usedUsd.toFixed(2)}</strong> of $${spend.limitUsd.toFixed(2)}${pctTag}`;
      if (spend.remainingUsd != null) {
        html += `<div class="extra-sub">$${spend.remainingUsd.toFixed(2)} remaining this cycle</div>`;
      }
      if (overLimit) {
        html += `<div class="extra-note">Over your billing-cycle spend cap</div>`;
      }
      detail.innerHTML = html;

      const pct = spend.utilization;
      bar.style.width = `${Math.min(100, pct)}%`;
      bar.style.backgroundColor = barColor(pct);
      if (barTrack) {
        barTrack.setAttribute("aria-valuenow", String(displayPct(Math.min(100, pct)) ?? 0));
        if (overLimit) {
          barTrack.setAttribute("aria-valuetext", `${displayPct(pct)}% — over limit`);
        }
      }
      resetEl.textContent = formatResetTime(state.billingCycleEnd);
      barWrap.style.display = "";
    } else if (spend.usedUsd != null) {
      detail.innerHTML = `<strong>$${spend.usedUsd.toFixed(2)}</strong> spent this cycle<div class="extra-sub">No spend cap set</div>`;
      barWrap.style.display = "none";
    } else {
      detail.textContent = "Waiting for spend data…";
      barWrap.style.display = "none";
    }
  } else {
    spendHeading.style.display = "none";
    spendSection.style.display = "none";
    if (spendHorizon) spendHorizon.style.display = "none";
  }

  // Usage analytics (summary + cap meters + event breakdown)
  const metersSlot = $("meters-slot");
  const usageHeading = $("usage-heading");
  const usageHorizon = $("usage-horizon");
  const summaryEl = $("analytics-summary");
  const eventsEl = $("events-list");
  metersSlot.innerHTML = "";
  if (eventsEl) eventsEl.innerHTML = "";

  const analytics = state.analytics || {};
  const meters = state.meters || [];
  const events = analytics.events || [];
  const hasAnalytics =
    analytics.totalCostUsd != null ||
    analytics.totalPosts != null ||
    analytics.totalUsers != null ||
    analytics.totalRequests != null ||
    events.some((e) => e?.used > 0) ||
    meters.length > 0;

  if (!showPrompt && hasAnalytics) {
    usageHeading.style.display = "";
    if (usageHorizon) usageHorizon.style.display = "";

    if (summaryEl) {
      const stats = [
        { label: "Cost", value: formatUsd(analytics.totalCostUsd) },
        { label: "Posts", value: formatCompact(analytics.totalPosts) },
        { label: "Users", value: formatCompact(analytics.totalUsers) },
        { label: "Requests", value: formatCompact(analytics.totalRequests) },
      ];
      summaryEl.innerHTML = stats
        .map(
          (s) =>
            `<div class="stat"><div class="stat-label">${s.label}</div>` +
            `<div class="stat-value">${s.value}</div></div>`
        )
        .join("");
      summaryEl.style.display = "";
      summaryEl.title = analytics.fromDate && analytics.toDate
        ? `Last 30 days · ${analytics.fromDate} → ${analytics.toDate}`
        : "Last 30 days";
    }

    for (const m of meters) {
      const pct = m.utilization;
      let valueText = formatPct(pct);
      if (m.used != null && m.limit != null) {
        valueText = `${formatCompact(m.used)} / ${formatCompact(m.limit)}`;
        if (pct != null) valueText += ` · ${formatPct(pct)}`;
      } else if (m.used != null) {
        valueText = formatCompact(m.used);
      }
      metersSlot.appendChild(
        buildBarSection({
          label: m.label || m.key || "Usage",
          valueText,
          pct,
          resetsAt: state.billingCycleEnd,
          overLimit: pct != null && pct > 100,
        })
      );
    }

    if (eventsEl) {
      const active = events.filter((e) => (e.used || 0) > 0);
      const zeroCount = events.length - active.length;
      if (active.length > 0) {
        eventsEl.innerHTML = "";
        const title = document.createElement("div");
        title.className = "events-list-title";
        title.textContent = "By event type";
        eventsEl.appendChild(title);

        for (const e of active) {
          const row = document.createElement("div");
          row.className = "event-row";
          const name = document.createElement("span");
          name.className = "event-name";
          name.textContent = e.label || e.key;
          const meta = document.createElement("span");
          meta.className = "event-meta";
          const count = document.createElement("strong");
          count.textContent = formatCompact(e.used);
          meta.appendChild(count);
          if (e.costUsd != null && e.costUsd > 0) {
            meta.appendChild(document.createTextNode(` · ${formatUsd(e.costUsd)}`));
          }
          row.appendChild(name);
          row.appendChild(meta);
          eventsEl.appendChild(row);
        }

        if (zeroCount > 0) {
          const zero = document.createElement("div");
          zero.className = "events-zero";
          zero.textContent = `${zeroCount} other types · no usage`;
          eventsEl.appendChild(zero);
        }
        eventsEl.style.display = "";
      } else {
        eventsEl.style.display = "none";
      }
    }
  } else {
    usageHeading.style.display = "none";
    if (usageHorizon) usageHorizon.style.display = "none";
    if (summaryEl) summaryEl.style.display = "none";
    if (eventsEl) eventsEl.style.display = "none";
  }

  $("meta-label").textContent = formatLastUpdated(state.lastUpdated);
}

function normalizeState(state) {
  return {
    ...DEFAULT_STATE,
    ...(state || {}),
    account: { ...DEFAULT_STATE.account, ...((state && state.account) || {}) },
    credits: { ...DEFAULT_STATE.credits, ...((state && state.credits) || {}) },
    spend: { ...DEFAULT_STATE.spend, ...((state && state.spend) || {}) },
    autoRecharge: {
      ...DEFAULT_STATE.autoRecharge,
      ...((state && state.autoRecharge) || {}),
    },
    meters: (state && state.meters) || [],
    analytics: {
      ...DEFAULT_STATE.analytics,
      ...((state && state.analytics) || {}),
      events: (state && state.analytics && state.analytics.events) || [],
    },
  };
}

async function loadAndRender() {
  try {
    const state = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_USAGE_STATE" }, (resp) => {
        if (chrome.runtime.lastError) {
          chrome.storage.local.get("usageState", ({ usageState }) => {
            resolve(usageState || DEFAULT_STATE);
          });
        } else {
          resolve(resp || DEFAULT_STATE);
        }
      });
    });
    render(normalizeState(state));
  } catch {
    document.getElementById("error-label").textContent = "Failed to load state.";
    document.getElementById("error-label").style.display = "block";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadAndRender();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.usageState) {
      render(normalizeState(changes.usageState.newValue));
    }
  });
  setInterval(loadAndRender, 30_000);

  const btn = document.getElementById("refresh-btn");
  btn.addEventListener("click", () => {
    btn.textContent = "…";
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");

    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      loadAndRender();
      btn.textContent = "Refresh";
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    };
    const safety = setTimeout(done, 10_000);
    chrome.runtime.sendMessage({ type: "FORCE_REFRESH" }, () => {
      void chrome.runtime.lastError;
      clearTimeout(safety);
      done();
    });
  });

  document.getElementById("open-usage-btn").addEventListener("click", async () => {
    let state = DEFAULT_STATE;
    try {
      state = await new Promise((resolve) => {
        chrome.storage.local.get("usageState", ({ usageState }) => {
          resolve(usageState || DEFAULT_STATE);
        });
      });
    } catch {
      // ignore
    }
    chrome.tabs.create({ url: consoleUrl(normalizeState(state)) });
  });
});
