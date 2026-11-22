# dsh-visualcost

**English** | [简体中文](README.zh-CN.md)

A status-bar pill for DeepSeek Harness that shows your **DeepSeek API balance**, **today's spend broken down by model**, and the current **peak / off-peak pricing period** — all pulled from DeepSeek's own balance and usage endpoints.

> **Unofficial.** This is a community plugin. It is not a DeepSeek release and is
> not affiliated with or endorsed by DeepSeek.
>
> **Runs with the harness's own permissions.** A DSH plugin is not sandboxed: it
> executes inside the harness process with the same file and process access as the
> app itself. It uses your `DEEPSEEK_API_KEY` credential and your signed-in platform
> session token only to call DeepSeek's own balance and usage endpoints. Read the
> source before installing.
>
> **Pinned to one DSH version.** Written and verified against DeepSeek Harness
> `0.2.2-rc.5` (Windows desktop). The platform usage endpoint is a private web
> endpoint and may change.

Developed and verified against **DeepSeek Harness `0.2.2-rc.5`** (Windows desktop).

## What it shows

- **Button (pill)**: `¥63.14 · ● 低谷` in the composer status bar. Large balances are compacted (`¥100.00M`), and the pill turns red when the balance drops below your configured alert bound.
- **Hover**: `距切换 4 小时 25 分钟` — the time until the next peak/off-peak switch (`X 天 Y 小时` when more than a day away).
- **Click**: a popup with
  - `低谷（剩余） 4 小时 25 分钟`
  - `充值余额 (CNY) ¥63.14` (bold)
  - `消费金额 (CNY) ¥18.02` (full precision, thousands-separated)
  - a thin per-model spend bar and a legend.
- **Balance alert off**: when you disable the balance alert on the platform, the popup shows a red `余额预警未开启` line with a `设置` link straight to the platform usage page.

## Data sources

- **Balance** — `GET https://api.deepseek.com/user/balance`, using the `DEEPSEEK_API_KEY` credential.
- **Today's spend** — the platform usage endpoint `GET /api/v0/usage/by_api_key/cost` (`start`/`end` = one Beijing-aligned day, `tz=28800`), authenticated with the signed-in platform session. Falls back to observed balance decreases, then a local token estimate.
- **Alert bound** — the platform-configured "余额预警" threshold, read from `/auth-api/v0/users/current`.

## Peak / off-peak

| Period | Time (Beijing) | Price |
| --- | --- | --- |
| Peak | Mon–Fri 09:00–12:00 and 14:00–18:00, excluding statutory holidays | standard |
| Off-peak | everything else (weekends, holidays, makeup weekends) | half |

Holidays are **not embedded**: on the first read of each Beijing day the plugin fetches that year's calendar from [`NateScarlet/holiday-cn`](https://github.com/NateScarlet/holiday-cn) and caches it in memory. A failed fetch keeps the previous cache and retries after 15 minutes; near year-end the next year is fetched too.

## Install

The bundle is a plain directory; no build step.

Install straight from GitHub:

```
dsh plugin --profile desktop add github:NAME7220/dsh-visualcost
```

Or clone it and add the local directory:

```
git clone https://github.com/NAME7220/dsh-visualcost.git
dsh plugin --profile desktop add <path-to-this-directory>
```

or, from inside DeepSeek Harness, use the plugin manager's `install_bundle` with the absolute path of this directory.

Then reload the client (refresh the window; restart the desktop app if the client module was already cached).

## Layout

```
index.js          host half: /api-balance/status.json route + spend accounting
client.js         browser half: the composer-dock button, hover tip, click popup
cordis.patch.yml  plugin row; balance-alert fallback thresholds (lowBalanceCNY / lowBalanceUSD)
locale/*.json     meta.title / meta.description for the plugin manager
docs/DETAIL.md    plugin detail page
icon.svg          plugin icon
```

## Requirements

- DeepSeek Harness `0.2.2-rc.5` (Windows desktop).
- The `conversation.composer.dock` slot, provided by `@deepseek-ai/dsh-client-ui-conversation`.
- A configured `DEEPSEEK_API_KEY` credential, and a signed-in DeepSeek account for the platform figures.

## License

MIT — see [LICENSE](LICENSE).
