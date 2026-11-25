## 数字人记忆摘要（自动维护，勿手改 · 详情见大脑仓库 memory/）

### 用户画像
- 我的家：通讯必须走通讯插件配置的地址，不要在功能里另开通道。
- 操作台·AI 对话默认用数字人自带种子 youmengyu-model（约12MB）；模型能做的事（日程/口算/本地记忆/本仓文档/寒暄）不再走 Skill 或 MCP，使用即训练。改代码仍走 Auto/Composer 或 ~游梦鱼。
- 操作台·AI 对话默认用数字人自带种子 youmengyu-model（约12MB）做测试；该模型必须随数字人不停升级完善，最终成为懂主人、技术比主人好的数字人。改代码仍走 Auto/Composer 或 ~游梦鱼。
- Trae 中所有文件修改必须直接应用落盘，禁止让主人逐个点「保留」按钮：已在 %APPDATA%/Trae CN/User/settings.json 设 AI.toolcall.reviewMode.ide=skip、AI.tool…
- 「我的家」每个版本打包 APP 图标都必须用仓内 doc/logo.png 生成（asaibuild 会跑 scripts/app-icons.mjs），禁止手改 mipmap / AppIcon / ico / splash 成品。…

### 本仓库要点
- 核心模块（被依赖最多）：
- src/store（被引 7）
- src/types（被引 5）
- src/inject（被引 4）
- src/agent-learn（被引 3）

### 高频改动
- `AGENTS.md` · `src/panel.ts` · `src/extension.ts` · `package.json` · `.youmengyu/test/unit/panel-shell.test.mjs` · `src/agent-learn.ts`

### 常用命令
- `git 用户名是「游梦鱼」，所以个人文件是 `CHANGELOG+游梦鱼.md…`
