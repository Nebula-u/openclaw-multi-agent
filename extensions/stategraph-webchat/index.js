import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isInteractiveManagerInbound(ctx, event, { managerAgentId = 'manager-agent', sessionPrefixes = [] } = {}) {
  if (ctx.agentId !== managerAgentId || !event.senderIsOwner) return false;
  const sessionKey = ctx.sessionKey ?? event.sessionKey ?? '';
  return sessionPrefixes.some((prefix) => sessionKey.startsWith(prefix));
}

export function isInteractiveManagerRun(ctx, event, { managerAgentId = 'manager-agent', sessionPrefixes = [] } = {}) {
  const trustedInteractiveSource = ctx.messageProvider === 'webchat' || event.senderIsOwner === true;
  if (ctx.agentId !== managerAgentId || !trustedInteractiveSource) return false;
  const sessionKey = ctx.sessionKey ?? '';
  return sessionPrefixes.some((prefix) => sessionKey.startsWith(prefix));
}

export default {
  id: 'stategraph-webchat', name: 'StateGraph Manager CLI Bridge', description: 'Keeps Manager conversation direct while processing user-confirmed workflow requests through StateGraph.',
  register(api) {
    const cfg = api.pluginConfig ?? {};
    const projectRoot = resolve(cfg.projectRoot ?? process.env.OPENCLAW_PROJECT_ROOT ?? process.cwd());
    const targetProjectRoot = resolve(cfg.targetProjectRoot ?? projectRoot);
    const managerWorkspace = resolve(cfg.managerWorkspace ?? join(projectRoot, 'runtime', 'agents', 'manager-agent', 'workspace'));
    let runtime; let processor; let timer;
    async function ready() {
      if (processor) return processor;
      const runtimeTokenPath = join(projectRoot, 'runtime', 'stategraph', 'runtime.capability');
      const humanTokenPath = join(projectRoot, 'runtime', 'stategraph', 'human-approval.capability');
      if (!existsSync(runtimeTokenPath) || !existsSync(humanTokenPath)) throw new Error('StateGraph capability 未初始化，请先运行 node scripts/workflow.mjs init --project-root .');
      const [{ createStateGraphRuntime }, { createManagerRequestProcessor }] = await Promise.all([
        import(pathToFileURL(join(projectRoot, 'scripts', 'stategraph', 'runtime.mjs')).href),
        import(pathToFileURL(join(projectRoot, 'scripts', 'stategraph', 'manager-request-queue.mjs')).href),
      ]);
      runtime = createStateGraphRuntime({ projectRoot, runtimeCapability: readFileSync(runtimeTokenPath, 'utf8').trim(), humanCapability: readFileSync(humanTokenPath, 'utf8').trim() });
      processor = createManagerRequestProcessor({ runtime, projectRoot, managerWorkspace, targetProjectRoot });
      return processor;
    }
    async function tick() {
      try { await (await ready()).scan(); }
      catch (error) { api.logger.error?.(`stategraph manager queue scan failed: ${error.stack ?? error.message}`); }
    }
    api.on('before_prompt_build', async (_event, ctx) => {
      const { consumeEphemeralSchema } = await import(pathToFileURL(join(projectRoot, 'scripts', 'stategraph', 'ephemeral-schema.mjs')).href);
      const appendContext = consumeEphemeralSchema({ projectRoot, sessionId: ctx.sessionId, agentId: ctx.agentId });
      return appendContext ? { appendContext } : undefined;
    }, { priority: 100 });
    api.on('gateway_start', async () => { await tick(); });
    timer = setInterval(() => void tick(), cfg.scanIntervalMs ?? 2000);
    timer.unref?.();
    api.on('gateway_stop', async () => { clearInterval(timer); runtime?.close(); runtime = null; processor = null; });
  },
};
