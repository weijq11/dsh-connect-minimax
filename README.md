# dsh-connect-minimax

把本机 MiniMax Code 桌面应用的登录态（免费额度）接入 DeepSeek Harness：

- **模型直连**：`minimax-code` provider 路由，走 `agent.minimax.cn` mavis 网关（Anthropic Messages 协议），模型目录自动发现（MiniMax-M3 / M3.1-Flash，含图片输入、自适应思考）。
- **积分概览**：设置页显示可用/累计/已用积分与签到日历；输入框区域在选中本插件模型时显示积分读数。
- **每日自动签到**：单实例串行、按本地日期去重、指数退避重试；也可在设置页手动签到。

## 安全模型

- 插件对 `~/.minimax/auth/**` **只读**：refresh token 一次性轮换，官方桌面应用是唯一刷新者。
- 任何输出（UI/路由/日志）都不包含令牌本体。
- webServer 路由仅接受 loopback Origin。

## 依赖

需要本机安装并登录 MiniMax Code 桌面应用（access token 过期时打开它刷新即可）。
