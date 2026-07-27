# MWI 公会试炼资料同步助手

由 adudu 维护的 Milky Way Idle 公会试炼成员资料同步脚本。

## 安装

[点击安装最新版 userscript](https://raw.githubusercontent.com/xiahuaaaa/mwi-guild-trial-helper/main/dist/mwi-guild-trial-sync.user.js)

需要先安装 Tampermonkey。安装后打开 MWI，脚本会自动读取并同步角色全部配装、技能和光环；生活配装也会完整保留。adudu 登录时还会自动同步本周 4 个生活试炼、2 个战斗试炼及战斗怪物的基础面板；打开 `公会 → 试炼` 后会继续同步完整报名名单、等级和定位，供 QQ 机器人查询和计算光环分配。

## 数据与隐私

- 仅确认属于 TMD 公会的角色会自动同步；其他公会安装后不会上传资料。
- 角色职业仍由成员在 QQ 机器人中绑定，不由脚本猜测。
- 本周试炼类型、怪物基础面板和整份报名名单仅允许 adudu 上报。
- 上传目标固定为管理员提供的公会服务。
- 快照会过滤 cookie、登录信息、会话和授权字段。
- 不上传 Discord 或 QQ 登录凭据。

默认公会服务：<https://adudu.tailab136f.ts.net>

## 许可

MIT License · 作者：adudu
