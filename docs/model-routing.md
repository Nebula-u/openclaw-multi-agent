# 模型配置与静态路由

## 配置原则

- 模型由受版本控制的 Agent package 默认值或安装时 `ModelConfig` 静态指定。
- 每个 Agent 可以配置不同的 `provider/model`，但 Agent 不得在运行时自行选模、升级、降级或修改 provider。
- 本轮保留现有 package 的默认 `model` 字段，避免原地更新意外改变已安装 Agent；新部署可复制 `config/agent-models.example.json` 后逐 Agent 覆盖。
- Provider 统一按 OpenAI Chat Completions 兼容配置。模板见 `config/openai-provider.example.json`。
- 不使用请求级或 provider 级结构化输出模式；JSON/JSONL 权威边界仍是本地确定性清洗、Ajv 校验和 Control Kernel ingestion。

## 安装时选择不同模型

Windows：

```powershell
Copy-Item '.\config\agent-models.example.json' '.\config\agent-models.json'
# 编辑 agent-models.json 后先 dry-run
pwsh -NoProfile -File '.\scripts\install.ps1' `
  -RuntimeRoot '.\runtime' `
  -ModelConfig '.\config\agent-models.json'
```

Linux：

```bash
cp config/agent-models.example.json config/agent-models.json
# 编辑 agent-models.json 后先 dry-run
bash scripts/install.sh \
  --runtime-root runtime \
  --model-config config/agent-models.json
```

配置文件只接受 `agents.<agent-id>.model` 静态覆盖。没有 `routing`、`selector` 或 Agent 自主切换字段；空值保留 package 默认模型。

## 通用 Provider 边界

`config/openai-provider.example.json` 使用以下统一设置：

- API：`openai-completions`
- 上下文窗口：128,000 tokens
- 单次输出上限：49,152 tokens
- 输出 token 字段：`max_completion_tokens`
- API Key：只通过 OpenClaw auth/profile 管理，不写入项目配置、日志、报告或备份样例

模型不支持模板字段时，应在部署前通过 OpenClaw 配置校验和模型 probe 明确失败，不允许 Agent 在执行中自行换模型兜底。

## 会话预算

模型上下文窗口和持久 session 累计预算是两个不同概念：

- 单次上下文窗口：128k。
- Manager 上下文软阈值：76,800（128k 的 60%），达到后创建新会话并只恢复紧凑控制上下文。
- 单个持久 session 累计 token 上限：200k；它不是单次模型请求可用窗口。

输出上限保持 49,152。模型输出被截断、为空或不符合 Schema 时，仍由通用失败链路处理，不做厂商特判。
