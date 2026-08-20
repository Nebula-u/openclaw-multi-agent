// Control Kernel 标识符生成器。
// 统一 ID 形态，保证 Kernel 内部 ID 可读、可索引、可在日志/URL/文件名中安全传播。
// 所有 ID 只含 ASCII 大写字母 / 数字 / 连字符。
//
// 设计约定：run_id 与 langgraph_thread_id 是**两个独立标识**。
//   run_id              由 Kernel 生成，形如 RUN-<12hex>，是事实表主键；
//   langgraph_thread_id 是历史兼容列；新的 workflow_id 由 Orchestrator 冻结。
// 两者 1:1 关联，通过 kernel.runs 行绑定。之所以不复用同一个值：
// executionIdFor / artifactIdFor 都要从 run_id 剥掉 "RUN-" 前缀拼子 ID，
// 而 schema 的 runs.run_id 也有 ^RUN- 的 CHECK 约束，与 WF-* 形态冲突。

import { randomUUID } from 'node:crypto';

/** 从带前缀的 ID 抽出短签名，用于拼接子 ID。 */
function baseOf(id, prefix) {
  if (typeof id !== 'string' || !id.startsWith(prefix)) {
    throw new TypeError(`expected id to start with "${prefix}", got ${String(id)}`);
  }
  return id.slice(prefix.length);
}

/**
 * 生成一个新的 run 标识：RUN-<12hex>。
 * 每次调用产生新值；绑定哪个 langgraph_thread_id 由 repository.upsertRun 决定。
 */
export function newRunId() {
  return `RUN-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/**
 * 校验一个 run_id 形态是否合法，合法则原样返回。
 * 供已持有 run_id 的调用方使用（例如 appendEvent），避免各处手写校验。
 */
export function runIdFor(runId) {
  if (typeof runId !== 'string' || !/^RUN-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(runId)) {
    throw new TypeError(`runId must match ^RUN-<id>, got ${String(runId)}`);
  }
  return runId;
}

/** 校验历史兼容线程标识（形态不受 Kernel 约束，只要非空字符串）。 */
export function threadIdFor(threadId) {
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new TypeError(`threadId must be a non-empty string, got ${String(threadId)}`);
  }
  return threadId;
}

/** 生成一次执行的唯一标识：EXE-<run短签>-A<attempt>-C<cycle>-<随机8位>。 */
export function executionIdFor(runId, { attempt, cycle = 0 } = {}) {
  const base = baseOf(runIdFor(runId), 'RUN-');
  return `EXE-${base}-A${attempt}-C${cycle}-${randomUUID().slice(0, 8)}`;
}

/** 为一次执行生成一个内容寻址产物的登记 ID：ART-<run短签>-<随机8位>。 */
export function artifactIdFor(runId) {
  const base = baseOf(runIdFor(runId), 'RUN-');
  return `ART-${base}-${randomUUID().slice(0, 8)}`;
}

/** 事件 ID：EVT-<run短签>-<随机8位>。 */
export function eventIdFor(runId) {
  const base = baseOf(runIdFor(runId), 'RUN-');
  return `EVT-${base}-${randomUUID().slice(0, 8)}`;
}
