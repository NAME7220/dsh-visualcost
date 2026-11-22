# API 余额与峰谷时段

在对话输入框下方的状态条里增加一个胶囊，包含两块：

- **余额按钮**（可点击，无悬停提示）：显示 DeepSeek API 余额（`/user/balance`）。低于预警线（人民币 10 元 / 美元 2 元）或 `is_available` 为 false 时金额变红。
  - **点击**：浮窗顶部「充值余额 ¥X」，中间「消费金额 (CNY) ¥X」，下面一条按模型占比堆叠的细条，再下面图例列出各模型金额。
- **峰谷标签**（不可点击，仅悬停）：显示当前「高峰 / 低谷」及色点（橙 / 绿）。
  - **悬停**：显示「距切换 X 小时 Y 分钟」；超过一天显示「X 天 Y 小时」。

## 消费金额口径（平台官方）

消费金额来自 DeepSeek 用量页所用的同一接口：

```
GET platform.deepseek.com/api/v0/usage/by_api_key/cost
  ?start=<北京当日 0 点秒>  &end=<start + 86400>  &tz=28800
```

- `start`/`end` 必须是**北京 0 点对齐的完整一天窗口**（`end - start === 86400`），否则服务端返回 `INVALID_PARAM`。
- 认证用 DSH 账号服务 `ctx.get('deepseekAccount').getPlatformSession()` 拿到的登录态 token（`x-dsh-auth-token`）。
- 响应里 `data.biz_data.data[].series[].buckets[].cost` 就是每个模型当天的金额（CNY）；插件按模型名合并后展示，`tool-search` 这类 function 用量也一并计入。

平台数据拿不到时依次兜底：**余额观测**（累计当天余额下降）→ **token 单价估算**。

## 时段规则

| 时段 | 时间（北京时间） | 价格 |
| --- | --- | --- |
| 高峰 | 周一至周五 09:00–12:00、14:00–18:00（不含法定节假日） | 标准价 |
| 低谷 | 其余全部时间（含周末、法定节假日全天、调休上班的周末） | 高峰价的一半 |

## 主题

- 悬停提示沿用 DSH 原生 tooltip 主题（`--dsw-alias-tooltip-bg` / `--dsw-alias-tooltip-label`）。
- 浮窗沿用 DSH 菜单主题（`--dsw-specific-menu`、`--dsw-elevation-prominent`、`--dsw-alias-border-l2`）。

## 实现方式

- 宿主注册只读路由 `/api-balance/status.json?session=<id>`，返回 `{ period, nextTransitionMs, balance, todaySpend, byModel, source, model, price }`；浏览器每 60 秒轮询。
- 余额每 60 秒拉取；平台用量每 2 分钟拉取。
- 峰谷计算、单价、预警线为源码顶部常量；节假日清单运行时从公开数据源拉取并缓存。

## 限制

- 平台用量接口为**私有网页接口**，随时可能变更；失效时自动走本地兜底。
- 需要 DSH 已登录 DeepSeek 账号（有登录态 token）才能取平台官方值。
- 节假日清单不内置：每个北京日首次读取时从 [`NateScarlet/holiday-cn`](https://github.com/NateScarlet/holiday-cn) 拉取当年 JSON 并缓存；拉取失败沿用旧缓存，15 分钟后重试；临近跨年时顺带拉下一年。
