import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isInteractiveManagerInbound(ctx, event, { managerAgentId = 'manager-agent', sessionPrefixes = [] } = {}) {
  if (ctx.agentId !== managerAgentId || !event.senderIsOwner) return false;
  const sessionKey = ctx.sessionKey ?? event.sessionKey ?? '';
  return sessionPrefixes.some((prefix) => sessionKey.startsWith(prefix));
}

export function isInteractiveManagerRun(ctx, event, { managerAgentId = 'manager-agent', sessionPrefixes = [] } = {}) {
  const trustedInteractiveSource = event.senderIsOwner === true || event.channelId === 'webchat';
  if (ctx.agentId !== managerAgentId || !trustedInteractiveSource) return false;
  const sessionKey = ctx.sessionKey ?? '';
  return sessionPrefixes.some((prefix) => sessionKey.startsWith(prefix));
}

export default {
  id: 'stategraph-webchat', name: 'StateGraph WebChat Bridge', description: 'Routes manager WebChat requests through the trusted StateGraph checkpoint runtime.',
  register(api) {
    const cfg = api.pluginConfig ?? {};
    const projectRoot = resolve(cfg.projectRoot ?? process.env.OPENCLAW_PROJECT_ROOT ?? process.cwd());
    const targetProjectRoot = resolve(cfg.targetProjectRoot ?? projectRoot);
    const managerAgentId = cfg.managerAgentId ?? 'manager-agent';
    const sessionPrefixes = cfg.sessionPrefixes ?? [
      `agent:${managerAgentId}:tui-`,
      `agent:${managerAgentId}:dashboard:`,
      `agent:${managerAgentId}:main`,
    ];
    let runtime; let bridge; let timer;
    async function ready() {
      if (bridge) return bridge;
      const runtimeTokenPath = join(projectRoot, 'runtime', 'stategraph', 'runtime.capability');
      const humanTokenPath = join(projectRoot, 'runtime', 'stategraph', 'human-approval.capability');
      if (!existsSync(runtimeTokenPath) || !existsSync(humanTokenPath)) throw new Error('StateGraph capability 未初始化，请先运行 node scripts/workflow.mjs init --project-root .');
      const [{ createStateGraphRuntime }, { createWebchatWorkflowBridge }] = await Promise.all([
        import(pathToFileURL(join(projectRoot, 'scripts', 'stategraph', 'runtime.mjs')).href),
        import(pathToFileURL(join(projectRoot, 'scripts', 'stategraph', 'webchat-bridge.mjs')).href),
      ]);
      runtime = createStateGraphRuntime({ projectRoot, runtimeCapability: readFileSync(runtimeTokenPath, 'utf8').trim(), humanCapability: readFileSync(humanTokenPath, 'utf8').trim() });
      bridge = createWebchatWorkflowBridge({ runtime, projectPath: targetProjectRoot });
      timer = setInterval(() => void bridge.scan().catch((error) => api.logger.error?.(`stategraph-webchat scan failed: ${error.message}`)), cfg.scanIntervalMs ?? 2000);
      timer.unref?.();
      return bridge;
    }
    async function handle(text, sessionKey, senderId) {
      api.logger.info?.(`stategraph-webchat claimed owner message for ${sessionKey}`);
      return (await ready()).handle({ text, sessionKey, senderId });
    }
    api.on('inbound_claim', async (event, ctx) => {
      if (!isInteractiveManagerInbound(ctx, event, { managerAgentId, sessionPrefixes })) return;
      if (!event.content?.trim()) return { handled: true, reply: { text: '需求内容不能为空。' } };
      try {
        const result = await handle(event.content, ctx.sessionKey ?? event.sessionKey, ctx.senderId ?? event.senderId);
        return { handled: true, reply: { text: result.reply } };
      }
      catch (error) { api.logger.error?.(`stategraph-webchat intake failed: ${error.stack ?? error.message}`); return { handled: true, reply: { text: `StateGraph 接入失败：${error.message}` } }; }
    });
    // Dashboard, TUI and CLI turns bypass channel ingress. Gate them before
    // the manager model runs; explicit graph child sessions still pass.
    api.on('before_agent_run', async (event, ctx) => {
      if (!isInteractiveManagerRun(ctx, event, { managerAgentId, sessionPrefixes })) return { outcome: 'pass' };
      if (!event.prompt?.trim()) return { outcome: 'block', reason: 'empty workflow request', message: '需求内容不能为空。', category: 'stategraph_workflow' };
      try {
        const result = await handle(event.prompt, ctx.sessionKey, event.senderId);
        return { outcome: 'block', reason: 'handled by StateGraph workflow', message: result.reply, category: 'stategraph_workflow' };
      }
      catch (error) {
        api.logger.error?.(`stategraph-webchat intake failed: ${error.stack ?? error.message}`);
        return { outcome: 'block', reason: 'StateGraph workflow intake failed', message: `StateGraph 接入失败：${error.message}`, category: 'stategraph_workflow_error' };
      }
    }, { priority: 100, timeoutMs: 120000 });
    api.on('gateway_stop', async () => { clearInterval(timer); runtime?.close(); runtime = null; bridge = null; });
  },
};
