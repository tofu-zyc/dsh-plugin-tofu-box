export const inject = ['agentTeams', 'tools'];
const ROOT = 'session-aa4cd13c-84e3-4144-aceb-364b5e339a93';
export function apply(ctx) {
  function selected(agent) {
    if (!agent) return false;
    const member = ctx.agentTeams.tryMembership(agent);
    return member?.role === 'teammate' && member.root.id === ROOT;
  }
  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next();
    if (!selected(agent)) return config;
    return { ...config, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' };
  });
  ctx.tools.guard(exec => {
    if (!selected(exec.agent)) return;
    if (/^(subagent(?:_|$)|spawn_teammate$|workflow$|create_goal$|plugin_manager$)/.test(exec.name))
      return 'Task policy: no recursive delegation, goal creation, or plugin installation; report to Lead.';
  });
}
