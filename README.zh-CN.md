# dsh-visualcost

[English](README.md) | **简体中文**

一个 DeepSeek Harness 状态栏胶囊：显示 **DeepSeek API 余额**、**当日按模型拆分的消费金额**，以及当前的 **高峰 / 低谷计费时段**，数据全部来自 DeepSeek 官方的余额与用量接口。

> **非官方插件。** 这是社区插件，不是 DeepSeek 的发布版本，与 DeepSeek 无隶属或背书关系。
>
> **以宿主进程同等权限运行。** DSH 插件没有沙箱：它在宿主进程内执行，与 App 本身拥有相同的文件与进程访问权限。它只会用你的 `DEEPSEEK_API_KEY` 凭据和已登录的平台会话 token 去调用 DeepSeek 官方的余额 / 用量接口。安装前请阅读源码。
>
> **锁定单一 DSH 版本。** 仅针对 DeepSeek Harness `0.2.2-rc.5`（Windows 桌面版）编写并验证。平台用量接口是私有网页接口，可能随时变更。

在 **DeepSeek Harness `0.2.2-rc.5`**（Windows 桌面版）上开发并验证。

## 展示内容

- **按钮（胶囊）**：状态栏里的 `¥63.14 · ● 低谷`。大额余额自动压缩（`¥100.00M`）；余额低于你设置的预警线时胶囊变红。
- **悬停**：`距切换 4 小时 25 分钟` —— 距离下一次峰谷切换的时间（超过一天显示 `X 天 Y 小时`）。
- **点击**：浮窗显示
  - `低谷（剩余） 4 小时 25 分钟`
  - `充值余额 (CNY) ¥63.14`（粗体）
  - `消费金额 (CNY) ¥18.02`（完整精度 + 千分位）
  - 一条按模型占比堆叠的细条和图例。
- **余额预警关闭时**：若在官网关闭了余额预警，浮窗底部会显示红色 `余额预警未开启` 一行，并带一个直达官网用量页的 `设置` 链接。

## 数据来源

- **余额** —— `GET https://api.deepseek.com/user/balance`，使用 `DEEPSEEK_API_KEY` 凭据。
- **当日消费** —— 平台用量接口 `GET /api/v0/usage/by_api_key/cost`（`start`/`end` 为北京对齐的一整天，`tz=28800`），使用已登录的平台会话鉴权。拿不到时依次兜底：余额观测 → token 单价估算。
- **预警阈值** —— 官网配置的「余额预警」阈值，读取自 `/auth-api/v0/users/current`。

## 峰谷时段

| 时段 | 时间（北京时间） | 价格 |
| --- | --- | --- |
| 高峰 | 周一至周五 09:00–12:00、14:00–18:00（不含法定节假日） | 标准价 |
| 低谷 | 其余全部时间（周末、节假日全天、调休上班的周末） | 半价 |

节假日清单在 `index.js` 的 `HOLIDAYS` 中内置（2026 年安排），以后年度请自行补录。

## 安装

bundle 就是普通目录，无需构建。

直接从 GitHub 安装：

```
dsh plugin --profile desktop add github:NAME7220/dsh-visualcost
```

或克隆后添加本地目录：

```
git clone https://github.com/NAME7220/dsh-visualcost.git
dsh plugin --profile desktop add <目录绝对路径>
```

也可以进入 DeepSeek Harness 后，用插件管理器的 `install_bundle` 添加本目录的绝对路径。

然后重载客户端（刷新窗口；如果客户端模块已被缓存，则重启桌面 App）。

## 目录结构

```
index.js          宿主侧：/api-balance/status.json 路由 + 消费记账
client.js         浏览器侧：composer 栏按钮、悬停提示、点击浮窗
cordis.patch.yml  插件行；余额预警兜底阈值（lowBalanceCNY / lowBalanceUSD）
locale/*.json     插件管理器的 meta.title / meta.description
docs/DETAIL.md    插件详情页
icon.svg          插件图标
```

## 依赖

- DeepSeek Harness `0.2.2-rc.5`（Windows 桌面版）。
- `conversation.composer.dock` 插槽（由 `@deepseek-ai/dsh-client-ui-conversation` 提供）。
- 已配置的 `DEEPSEEK_API_KEY` 凭据，以及已登录的 DeepSeek 账号（用于读取平台官方数据）。

## 发布

1. 修改 `package.json` 里的 `version`。
2. 提交后打标签：`git tag -a v1.0.0 -m "dsh-visualcost 1.0.0"`。
3. 一并推送：`git push && git push origin v1.0.0`。
4. 在 GitHub 上为该标签草拟一个 release。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
