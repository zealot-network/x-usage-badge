# X Usage Badge

A Chrome extension that puts your X Developer Console usage in your browser toolbar.

> **Unofficial.** This is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by X Corp, Twitter, or xAI. "X" is a trademark of X Corp., used here only to describe what the extension does.

The badge shows how close you are to trouble — typically billing-cycle spend vs your spend cap, worst-cased with post-read meters. Click it for credit balance, spend vs limit, auto-recharge status, usage meters, and cycle countdown.

## Features

**Credits**
- Prepaid credit balance
- Free credit pool (when present), with expiry when available

**Billing-cycle spend**
- Current spend vs spend cap with progress bar
- Auto-recharge ON / OFF
- Over-limit state flagged loudly

**Usage meters**
- Post reads vs monthly cap (pay-per-use)
- User reads vs monthly cap (when present)

**Package / cycle**
- Plan pill (e.g. Pay Per Use)
- Billing-cycle end date with a live countdown

**Error handling**
- If your X session has expired or you aren't signed in, the popup guides you to console.x.com and back with a one-click Refresh

## Install

### From source (developer mode)

1. Clone this repo
2. Visit `chrome://extensions`
3. Toggle **Developer mode** on (top right)
4. Click **Load unpacked** → select this folder
5. Sign in at [console.x.com](https://console.x.com). The badge populates within a few seconds.

## How it works

The extension reads the same cookie-authenticated console APIs that power the Developer Console billing and usage pages:

- `GET /api/me` — account + billing cycle
- `GET /api/accounts/{id}/credits` — balance + spend cap + auto-recharge threshold
- `GET /api/accounts/{id}/spend` — cycle spend totals
- `GET /api/accounts/{id}/usage?interval=current` — post/user read meters

- `background.js` — service worker, single source of truth. Polls every 3 minutes plus on-demand.
- `popup.html` / `popup.js` — the UI. Light xAI-inspired chrome (off-white, not the black Claude/Cursor popups).

Auth uses your existing X session cookies on `console.x.com` (`auth_token` + `ct0` CSRF). No token pasting required — just stay signed in to the console in Chrome.

## Permissions

- `storage` — persists usage state between browser restarts
- `cookies` — detects whether an X session cookie is present / reads `ct0` for CSRF
- `alarms` — periodic background refresh every 3 minutes
- `host_permissions: ["https://console.x.com/*"]` — required to call the console APIs on your behalf

**No data leaves your browser.** No third-party servers. No analytics. No tracking.

## Design

Popup UI follows [xAI](https://x.ai) brand standards (All Brand Standards DB) inverted onto a light ground so it is visually distinct from the near-black Claude / Cursor siblings:

| Token | Hex | Use |
|---|---|---|
| Background | `#E1E4E8` | Popup page (xAI off-white) |
| Surface | `#FFFFFF` | Elevated cards |
| Text | `#0A0A0A` | Primary copy |
| Accent | `#FF6308` | Title, mono labels, icon ring (xAI orange) |
| Severity bars | `#22c55e` / `#f59e0b` / `#ef4444` | Progress fills |
| Live `%` badge | `#15803D` / `#B45309` / `#B91C1C` | Toolbar overlay (Claude/Cursor scheme) |

Typography: Inter + JetBrains Mono. Store listing assets live in `../store-assets/`.

## Development

There's no build step. Edit the files in place and reload the extension at `chrome://extensions` (↻ icon on the extension card).

To package for the Chrome Web Store:

```bash
zip -r ../x-usage-badge.zip . -x "*.DS_Store" -x "__MACOSX/*" -x ".git/*" -x ".tmp/*"
```

## Smoke test

1. Load unpacked as above
2. Open [console.x.com](https://console.x.com) and confirm you're signed in
3. Click the extension icon → **Refresh**
4. Confirm the badge shows a percentage and the popup shows:
   - Package pill
   - Billing-cycle end + countdown
   - Credit balance
   - Spend vs cap (and auto-recharge status)
   - Post-read meter (when available)

## License

MIT — see [LICENSE](LICENSE).

Framework adapted from [cursor-usage-badge](https://github.com/zealot-network/cursor-usage-badge) / [claude-usage-badge](https://github.com/zealot-network/claude-usage-badge).
