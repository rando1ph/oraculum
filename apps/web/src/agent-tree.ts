import type { AgentState, AgentSummary } from '../../../packages/shared/subagents';
import type { ItemView } from './store';

export type AgentNode = {
  id: string; parentId: string | null; name: string; role: string | null;
  status: AgentState; progress: string | null; result: string | null; prompt: string | null;
};
export const agentTerminal = (status: AgentState) => ['completed', 'errored', 'interrupted', 'shutdown', 'notFound'].includes(status);
export const agentLabels: Record<AgentState, string> = { unknown: '状态未知', pendingInit: '等待启动', running: '运行中', completed: '已完成', errored: '执行失败', interrupted: '已中断', shutdown: '已关闭', notFound: '未找到' };
const nativeState = (value: string): value is AgentState => Object.hasOwn(agentLabels, value);

// Native participant IDs identify nodes. Only spawn calls or verified thread
// metadata establish hierarchy; activity paths and wait/send calls do not.
export function buildAgents(views: ItemView[], root: string, summaries: Record<string, AgentSummary> = {}): AgentNode[] {
  const nodes = new Map<string, AgentNode>();
  const node = (id: string) => {
    if (!id || id === root) return;
    if (!nodes.has(id)) nodes.set(id, { id, parentId: null, name: `子代理 ${id.slice(0, 12)}`, role: null, status: 'unknown', progress: null, result: null, prompt: null });
    return nodes.get(id)!;
  };
  for (const { item } of views) {
    if (item.type === 'collabAgentToolCall') {
      for (const id of new Set([...item.receiverThreadIds ?? [], ...Object.keys(item.agentsStates ?? {})])) {
        const value = node(id);
        if (!value) continue;
        if (item.tool === 'spawnAgent' && item.senderThreadId && item.senderThreadId !== id) {
          value.parentId = item.senderThreadId; value.prompt = item.prompt || value.prompt;
          if (item.senderThreadId !== root) node(item.senderThreadId);
        }
        const state = item.agentsStates?.[id];
        if (!state || !nativeState(state.status)) continue;
        // Explicit native task/resume operations can start another run. A late
        // wait/list/activity snapshot cannot revive an already terminal agent.
        const newRun = ['resumeAgent', 'followupTask', 'sendInput'].includes(item.tool);
        if (agentTerminal(value.status) && !agentTerminal(state.status) && !newRun) continue;
        if (newRun && !agentTerminal(state.status)) { value.result = null; value.progress = null; }
        value.status = state.status;
        if (state.message) {
          if (state.status === 'completed') value.result = state.message;
          else value.progress = state.message;
        }
      }
    }
    if (item.type === 'subAgentActivity') {
      const value = node(item.agentThreadId);
      if (!value) continue;
      if (item.agentPath) value.name = item.agentPath;
      const status = ({ started: 'running', completed: 'completed', interrupted: 'interrupted' } as const)[item.kind as 'started' | 'completed' | 'interrupted'];
      if (status && !(agentTerminal(value.status) && !agentTerminal(status))) value.status = status;
    }
  }
  // Include verified nested descendants of participants already in this turn.
  for (let pass = 0; pass < 16; pass++) {
    let added = false;
    for (const summary of Object.values(summaries)) if (!nodes.has(summary.id) && nodes.has(summary.parentThreadId)) { node(summary.id); added = true; }
    if (!added) break;
  }
  for (const value of nodes.values()) {
    const summary = summaries[value.id];
    if (!summary) continue;
    value.parentId = summary.parentThreadId;
    value.name = summary.nickname || value.name; value.role = summary.role;
    if (summary.status !== 'unknown' && !(agentTerminal(value.status) && !agentTerminal(summary.status))) value.status = summary.status;
    value.progress = summary.progress || value.progress; value.result = value.result || summary.result;
  }
  for (const value of nodes.values()) {
    const seen = new Set([value.id]);
    let parent = value.parentId;
    while (parent && parent !== root) {
      if (seen.has(parent) || !nodes.has(parent)) { value.parentId = null; break; }
      seen.add(parent); parent = nodes.get(parent)!.parentId;
    }
  }
  return [...nodes.values()];
}

export function orderedAgents(nodes: AgentNode[], root: string) {
  const output: { node: AgentNode; depth: number }[] = [], seen = new Set<string>();
  const visit = (node: AgentNode, depth: number) => {
    if (seen.has(node.id)) return;
    seen.add(node.id); output.push({ node, depth });
    for (const child of nodes) if (child.parentId === node.id) visit(child, depth + 1);
  };
  for (const node of nodes) if (!node.parentId || node.parentId === root) visit(node, 0);
  for (const node of nodes) visit(node, 0);
  return output;
}
