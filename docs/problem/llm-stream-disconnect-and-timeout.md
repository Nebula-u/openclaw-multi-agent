# Manager LLM 流断开与超时待解决问题

> 状态：待处理
> 记录日期：2026-08-03
> 影响范围：`manager-agent` 的 OpenClaw TUI/Gateway 会话。

## 已确认事实

- 全局 `agents.defaults.timeoutSeconds` 未配置，Manager 也没有单独超时配置。TUI 使用的 OpenClaw Agent 级默认超时为 172,800 秒（48 小时）；`openclaw agent` CLI 的 600 秒默认值不适用于当前 TUI 会话。
- 本次失败的 Gateway 记录持续 1,206,177 ms（约 20 分 6 秒）。传输层没有本地 HTTP deadline（`timeoutMs=undefined`）；上游流在收到 HTTP 200 后、最终完成事件前断开，OpenClaw 将其归类为 `LLM request timed out`。
- 失败时 Manager 主会话使用 `newapi/gpt-5.6-luna` 的 Chat Completions 路由，约 9.3 万输入 token、`thinking=high`；Gateway 同时报告约 1.58 GiB RSS 内存压力。
- 项目预期的 `newapi-responses/gpt-5.6-luna` 路由探测返回 HTTP 401，说明该 provider 的当前凭据不可用。当前会话的 Chat 路由覆盖不能在修复凭据前直接清除。
- Manager 没有配置模型 fallback；主路由流断开后只能直接报错。

## 根因判断

直接错误是上游 `newapi` 流式响应在完成前断开，不是项目配置的本地超时到期。长上下文、高思考级别、没有回退模型和 Gateway 内存压力提高了长时间流式任务失败后的恢复成本。Responses 路由凭据失效使系统无法切换到项目预期的默认路由。

## 解决方案

1. 以交互式方式为 `newapi-responses` 更新有效 API Key，禁止在仓库、日志、问题文档或聊天中记录密钥：

   ```powershell
   openclaw models auth paste-api-key --agent manager-agent --provider newapi-responses
   openclaw models status --agent manager-agent --probe
   ```

   只有 probe 成功后，才继续恢复 `newapi-responses/gpt-5.6-luna` 为 Manager 新会话的有效路由。

2. 修复凭据后，清除 Manager 主会话的 `providerOverride` / `modelOverride`，并创建新会话或执行 `/new`。不要继续复用当前超长历史；将思考级别设为 `medium` 或更低，按任务拆分上下文。

3. 为 Manager 配置至少一个已经实际 probe 成功的 fallback 模型。回退模型的 provider、协议和任务适用范围须记录在 `docs/model-routing.md`，并经人工审批后写入运行时配置。

4. 将 `agents.defaults.timeoutSeconds` 设为经批准的明确上限，例如 900 秒，作为工作流的熔断保护。该设置影响全部 Agent，不能修复上游流断开，只能缩短无效阻塞时间。

5. 在无活动任务且用户确认可中断时重启 Gateway，释放内存压力。重启会断开 TUI 和正在运行的 Agent，不得在活动任务期间擅自执行。

6. 增加运行监测：记录每次模型调用的 provider/model、上下文 token、thinking 级别、开始/结束时间、流断开原因、fallback 决策和最终状态；不得记录密钥或完整敏感提示。

## 验收标准

- `newapi-responses/gpt-5.6-luna` probe 成功，且新 Manager 会话实际使用该路由。
- 新会话不继承旧模型覆盖，输入上下文显著低于当前 9.3 万 token。
- 主模型流断开时，已验证 fallback 能被调用并记录原因；无 fallback 时工作流进入明确 `HOLD`，不伪造完成。
- Gateway 在正常工作负载下不持续报告内存压力；超时/断开事件可从脱敏诊断日志追溯。

## 风险与限制

- 不应仅通过增加超时解决问题；本次是上游流断开而非本地短超时。
- 在 Responses provider 凭据修复并 probe 成功前，切换默认模型会使 Manager 新会话直接认证失败。
- 超时、fallback 和 Gateway 重启属于运行时策略变更，应由用户批准后实施并在验收后同步项目状态文档。
