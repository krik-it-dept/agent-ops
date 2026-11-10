import type { AgentOpsBridge } from '../shared/contracts';

declare global {
  interface Window {
    agentOps: AgentOpsBridge;
  }
}
