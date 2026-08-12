# 模型配置与静态路由

## 配置原则

- 模型由项目根 `.env` 静态指定；未填写时才回退到受版本控制的 Agent package 默认值。
- 每个 Agent 可以配置不同的 `provider/model`，但 Agent 不得在运行时自行选模、升级、降级或修改 provider。
- 本轮保留现有 package 的默认 `model` 字段，避免原地更新意外改变已安装 Agent；旧 `ModelConfig` JSON 只用于兼容回退。
- Provider 默认按 OpenAI Chat Completions 兼容配置；完整值由项目根 `.env` 提供。模板见 `config/openai-provider.example.json`。
- 不使用请求级或 provider 级结构化输出模式；JSON/JSONL 权威边界仍是本地确定性清洗、Ajv 校验和 Control Kernel ingestion。

## 安装时选择不同模型

Windows（`.env` 已存在时无需复制 JSON）：

```powershell
# 编辑 .env 中的 OPENCLAW_AGENT_<ID>_MODEL 后先 dry-run
pwsh -NoProfile -File '.\scripts\install.ps1' `
  -RuntimeRoot '.\runtime'
```

Linux：

```bash
# 编辑 .env 中的 OPENCLAW_AGENT_<ID>_MODEL 后先 dry-run
bash scripts/install.sh --runtime-root runtime
```

项目根 `.env` 是实际运行时配置入口；`.env.example` 是无密钥模板。旧 `ModelConfig` JSON 仅作为兼容回退，不覆盖 `.env` 中的非空模型配置。

## 通用 Provider 边界

`.env` 使用以下统一设置：

- API：`openai-completions`
- 上下文窗口：128,000 tokens
- 单次输出上限：49,152 tokens
- 输出 token 字段：`max_completion_tokens`
- API Key：只通过 OpenClaw auth/profile 管理，不写入项目配置、日志、报告或备份样例

若某个 Agent 与公共值不同，可使用同名 Agent 前缀覆盖，例如：

```dotenv
OPENCLAW_AGENT_ARCHITECT_AGENT_CONTEXT_WINDOW_TOKENS=128000
OPENCLAW_AGENT_ARCHITECT_AGENT_MAX_OUTPUT_TOKENS=49152
OPENCLAW_AGENT_ARCHITECT_AGENT_MAX_SESSION_TOKENS=200000
```

当前 `.env` 只维护 7 个原生 Agent；未写 per-Agent 数值时继承公共值。

安装器 apply 时还会把每个已引用模型的 `contextWindow`、`maxTokens` 和
`compat.maxTokensField` 同步到 OpenClaw 的 `models.providers` 目录，只更新对应模型，不覆盖 API key 或其他模型。若同一个模型被多个 Agent 使用，它们的限制必须一致。

模型不支持模板字段时，应在部署前通过 OpenClaw 配置校验和模型 probe 明确失败，不允许 Agent 在执行中自行换模型兜底。

## 会话预算

模型上下文窗口和持久 session 累计预算是两个不同概念：

- 单次上下文窗口：128k。
- Manager 上下文软阈值：76,800（128k 的 60%），达到后创建新会话并只恢复紧凑控制上下文。
- 单个持久 session 累计 token 上限：200k；它不是单次模型请求可用窗口。

输出上限保持 49,152。模型输出被截断、为空或不符合 Schema 时，仍由通用失败链路处理，不做厂商特判。
