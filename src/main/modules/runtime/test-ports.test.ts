import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  isolatedTestPorts,
  sampleModeAllowed,
  type TestPorts,
} from './test-ports';
describe('external main test harness boundary', () => {
  it('ignores the sample flag in packaged builds and defaults to real data', () => {
    expect(sampleModeAllowed(true, { AGENT_OPS_UI_FIXTURES: '1' })).toBe(false);
    expect(sampleModeAllowed(false, {})).toBe(false);
    expect(sampleModeAllowed(false, { AGENT_OPS_UI_FIXTURES: '1' })).toBe(true);
  });
  it('cannot inject into packaged launches, ordinary development, or a non-temporary data root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-test-boundary-'));
    const key = Symbol.for('agent-ops:e2e');
    const values = globalThis as unknown as Record<symbol, unknown>;
    const previous = values[key];
    const ports = {} as TestPorts;
    values[key] = ports;
    try {
      const options = {
        packaged: false,
        dataDir: root,
        env: { AGENT_OPS_E2E: '1', AGENT_OPS_DATA_DIR: root },
      };
      expect(isolatedTestPorts(options)).toBe(ports);
      expect(isolatedTestPorts({ ...options, packaged: true })).toBeUndefined();
      expect(
        isolatedTestPorts({ ...options, env: { AGENT_OPS_DATA_DIR: root } }),
      ).toBeUndefined();
      expect(() =>
        isolatedTestPorts({
          ...options,
          dataDir: tmpdir(),
          env: { AGENT_OPS_E2E: '1', AGENT_OPS_DATA_DIR: tmpdir() },
        }),
      ).toThrow('separate folder');
    } finally {
      if (previous === undefined) delete values[key];
      else values[key] = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
