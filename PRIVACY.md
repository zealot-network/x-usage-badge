# Privacy Policy — X API Usage Tracker

**Last updated:** November 13, 2026

X API Usage Tracker (“the extension”, formerly X Usage Badge) is an unofficial, open-source Chrome extension. It is not affiliated with, endorsed by, or sponsored by X Corp, Twitter, or xAI.

## What the extension does

The extension shows your X Developer Console usage in the Chrome toolbar and popup: prepaid credit balance, billing-cycle spend vs spend cap, auto-recharge status, post-read meter, package tier, and billing-cycle reset timing.

## Data the extension accesses

To fulfill that single purpose, the extension:

1. **Reads your X session cookies** on `console.x.com` (notably `auth_token` for signed-in detection and `ct0` as a CSRF token) so it can call the Developer Console APIs while you are signed in. The extension does not ask you to paste a token and does not modify or store the cookie values separately.
2. **Requests usage and billing summary data from `console.x.com`** (the same unofficial console APIs used by the Credits and Usage pages).
3. **Stores a local cache** of usage state (balances, spend, meters, package, reset times, last error, last refresh time) in Chrome’s `chrome.storage` on your device so the badge and popup can update without re-fetching every click.

## What we do not do

- We do not operate a backend server for this extension.
- We do not send your usage data, cookies, or browsing activity to the extension author or any third party.
- We do not include analytics, advertising, or tracking SDKs.
- We do not sell or transfer user data.
- We do not use remote code; all JavaScript ships inside the extension package.

Network requests go only to `https://console.x.com/*` so the extension can read your usage from the Developer Console while you are logged in. X’s own privacy practices apply to data X processes on their servers.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Cache usage state locally for the badge and popup |
| `cookies` | Detect a signed-in X session and read `ct0` for CSRF on console API calls |
| `alarms` | Refresh usage on a timer (~every 3 minutes) |
| Host: `https://console.x.com/*` | Call Developer Console usage/billing APIs |

## Contact

Questions or privacy requests: open an issue at  
https://github.com/zealot-network/x-usage-badge/issues

Source code:  
https://github.com/zealot-network/x-usage-badge
