import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'stategraph-webchat', name: 'StateGraph WebChat Bridge', description: 'Routes manager WebChat requests through the trusted StateGraph checkpoint runtime.',
  register(api) {
    const cfg = api.pluginConfig ?? {};
    const projectRoot = resolve(cfg.projectRoot ?? process.env.OPENCLAW_PROJECT_ROOT ?? process.cwd());
    const targetProjectRoot = resolve(cfg.targetProjectRoot ?? projectRoot);
    const channels = new Set(cfg.channels ?? ['webchat']);
    const managerAgentId = cfg.managerAgentId ?? 'manager-agent';
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
    api.on('inbound_claim', async (event, ctx) => {
      if (ctx.agentId !== managerAgentId || !channels.has(ctx.channelId) || !event.senderIsOwner) return;
      if (!event.content?.trim()) return { handled: true, reply: { text: '需求内容不能为空。' } };
      try { const result = await (await ready()).handle({ text: event.content, sessionKey: ctx.sessionKey ?? event.sessionKey ?? `${ctx.channelId}:${ctx.conversationId}`, senderId: ctx.senderId ?? event.senderId }); return { handled: true, reply: { text: result.reply } }; }
      catch (error) { api.logger.error?.(`stategraph-webchat intake failed: ${error.stack ?? error.message}`); return { handled: true, reply: { text: `StateGraph 接入失败：${error.message}` } }; }
    });
    api.on('gateway_stop', async () => { clearInterval(timer); runtime?.close(); runtime = null; bridge = null; });
  },
};
