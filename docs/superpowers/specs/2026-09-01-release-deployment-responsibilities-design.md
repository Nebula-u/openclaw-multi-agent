# Release 部署职责重划设计

## 目标

将 `release-agent` 从“运维交接前的只读发布就绪校验者”扩展为同一受控阶段内的发布前检查与实际部署执行者。部署目标使用共享基础域名 `https://multiagentforge.cloud` 下的项目路径；Release 负责选择、登记、配置并验证该路径。

`review-agent` 继续只负责候选 Git commit 的代码与测试评审，不配置服务器、路由或生产环境，也不重复发布前检查或线上验证。

## 角色边界

### Manager

当用户请求部署时，Manager 必须在创建 workflow 前单独说明并取得确认：

- 部署属于外部副作用；
- 目标基础域名为 `https://multiagentforge.cloud`；
- Release 将在该基础域名下分配项目 URL 路径、执行部署、配置路由并验证上线；
- Release 前置检查通过后，还会就实际候选 commit 与最终 URL 请求一次部署确认。

部署请求的路线必须包含 `RELEASE`，并标记 `external_side_effect`、`release_risk` 和适用的 `manual_acceptance` 风险。Manager 不得将部署描述成 DEVELOPMENT、TEST 或 REQUIREMENTS 会执行的工作，也不得以“未请求版本 tag”作为跳过 RELEASE 的理由。

### Code Review

Code Review 的输入是候选 Git snapshot 与前序产物；输出是代码和测试的独立评审意见。它只负责：代码正确性、测试质量、缺陷、回归风险、依赖与静态安全风险，以及 commit 绑定。

它不读取或修改部署注册表、服务器配置、路由或生产凭证；不运行部署、发布前环境检查、线上健康检查或回滚。Release 只能消费其结论和候选 commit，不重新产生代码级 findings。

### Release

Release 以通过开发、测试和 Code Review 的固定候选 commit 为输入，分成两个不可混淆的子阶段：

1. **Preflight**：核对候选 commit 与 Review/Test 一致；检查构建工件、部署配置、环境前置、回滚方案和健康检查策略；从基础域名的路径注册表读取已用路径，为项目选择规范且未冲突的路径，优先使用项目的规范化名称（如 `todolist`）。
2. **Deploy**：仅在部署前确认已绑定候选 commit、最终 URL 和部署目标后，调用受 allowlist 约束的部署入口；配置或更新路径路由；执行部署后健康检查与关键路径 smoke test；保存部署日志、已部署 commit、最终 URL、检查结果与回滚状态。

路径冲突时，Release 选择语义接近且未被注册的替代路径；选择必须在部署前确认中明确展示。路径注册表和部署入口必须由宿主控制面管理，不能由模型以任意 shell、SSH 或原始凭证访问方式自由操作。

## 流程与审批

```text
Manager 初始部署确认
  -> DEVELOPMENT -> TEST -> CODE_REVIEW
  -> RELEASE preflight
  -> 用户部署前确认（candidate_commit + final_url + deployment target）
  -> RELEASE deploy -> online verification -> terminal delivery
```

初始确认授权 workflow 包含部署；部署前确认授权一项不可逆的具体动作。后者必须绑定 Release preflight 产出的 candidate commit、最终 URL、基础域名、目标环境和回滚计划标识，不能复用旧 approval，也不能因路径或 commit 改变而沿用。

Preflight 失败、缺少证据、路径无法安全分配、部署失败或线上验证失败，均不得报告成功部署；系统保留证据并按既定回滚策略回滚，或创建人工决策。

## 状态与交付契约

Release 对外区分以下事实：

- `READY_TO_DEPLOY`：Preflight 已通过，等待绑定实际 commit/URL 的人工部署确认；
- `DEPLOYED`：部署与上线验证通过；
- `DEPLOY_FAILED`：部署或上线验证失败；报告是否已回滚及其证据；
- `HOLD` / `NO_GO`：缺证据、风险或 Preflight 不通过，未执行部署。

Release 结果与最终报告必须区分“候选可部署”和“实际已部署”。实际部署结果至少包括：base URL、final URL path、完整最终 URL、项目标识、候选/已部署 commit、部署入口标识及其日志哈希、健康检查与 smoke test 证据、路径注册状态、回滚计划与实际回滚状态。

## 实现影响

实现会更新 Manager 与 Release workspace 规则、Agent package capability/工具 allowlist、路线和任务/结果/Gate/approval 契约、Orchestrator 路由与状态处理、部署路径注册与受控部署入口、报告模板和测试。既有安装脚本与 README 也必须同步，因为 Agent workspace、package/runtime bundle 和工具权限会变化。

不改变 Developer、Test 或 Review 的业务代码权限；生产部署权限只交给 Release 的受控、可审计入口。

## 验收标准

1. Manager 面对含部署的请求，先展示部署目标、共享基础域名、路径分配、Release 职责和两次确认，再创建 workflow。
2. 路线含 RELEASE；系统拒绝将“部署”需求以跳过 RELEASE 的普通功能路线提交。
3. Code Review 与 Release 的 prompts、task 契约与测试明确无重叠：前者不部署，后者不做代码评审。
4. Release 能为未冲突项目路径创建确定性注册记录；冲突时选用可显示、可审批的替代路径。
5. Release 只有在绑定实际 candidate commit 和 URL 的部署确认后才能调用部署入口。
6. 部署成功时，最终产物同时记录完整 URL、已部署 commit 和线上验证证据；失败时绝不标为 deployed，并记录回滚事实。
7. 现有非部署工作流保持不会获得生产部署权限。
