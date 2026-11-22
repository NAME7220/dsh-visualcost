# dsh-visualcost

DeepSeek Harness (DSH) plugin: one status-bar button in the composer dock that shows the API
balance, today's spend broken down by model, and the current peak / off-peak pricing period.

## What it shows

- **Button**: `¥{balance} · ● {peak|off-peak}` (red when the balance falls below ¥10 / $2).
- **Hover**: `距切换 X 小时 Y 分钟` (time until the next pricing switch).
- **Click**: a popup with
  - `低谷（剩余） … 4 小时 25 分钟`
  - `充值余额 (CNY) … ¥X` (bold)
  - `消费金额 (CNY) … ¥Y`
  - a thin per-model spend bar and legend.

## Data sources

- Balance: `GET https://api.deepseek.com/user/balance` with the `DEEPSEEK_API_KEY` credential.
- Spend: the platform usage endpoint `GET /api/v0/usage/by_api_key/cost`
  (`start`/`end` = one Beijing-aligned day, `tz=28800`), authenticated with the signed-in
  account token from `ctx.get('deepseekAccount').getPlatformSession()`.
  Falls back to observed balance decreases, then a local token estimate.

## Layout

```
index.js        host half: webServer route /api-balance/status.json + spend accounting
client.js       browser half: the composer-dock button, hover tip, click popup
locale/*.json   meta.title / meta.description for the plugin manager
docs/DETAIL.md  plugin detail page
icon.svg        plugin icon
```

## Install (local directory)

```text
Plugins → Add plugin → choose this directory
```
or via `plugin_manager` with `install_bundle` and this directory as the target.

## Notes

- The platform usage endpoint is a private web endpoint and may change; the plugin falls back
  to the local estimate when it is unavailable.
- Chinese statutory holidays are a hard-coded 2026 list in `index.js` (`HOLIDAYS`); update for
  later years.
