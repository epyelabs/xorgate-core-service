import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deviceResponse, type DeviceRow } from '../src/services/device-view';

/**
 * Dual-agent registration D3 + SDK review S2: every route that returns a device
 * carries `agent`. They all project through `deviceResponse`, so this pins the
 * projection and that no handler returns a device object without it.
 */

const base = {
  id: 'd1',
  workspaceId: 'w1',
  deviceModelId: 'm1',
  serial: 's',
  name: null,
  agentVersion: '9bd55b9',
  config: {},
} as unknown as DeviceRow;

describe('deviceResponse: agent', () => {
  it('carries agent as js or rust', () => {
    expect(deviceResponse({ ...base, agent: 'rust' } as DeviceRow).agent).toBe('rust');
    expect(deviceResponse({ ...base, agent: 'js' } as DeviceRow).agent).toBe('js');
  });

  it('a legacy or odd stored value reads as js', () => {
    for (const v of [undefined, null, '', 'RUST', 'node']) {
      expect(deviceResponse({ ...base, agent: v } as unknown as DeviceRow).agent).toBe('js');
    }
  });

  it('keeps agentVersion and its firmwareVersion alias', () => {
    const v = deviceResponse({ ...base, agent: 'rust' } as DeviceRow);
    expect(v.agentVersion).toBe('9bd55b9');
    expect(v.firmwareVersion).toBe('9bd55b9');
  });

  it('every handler that returns `device:` / `devices:` builds it with deviceResponse', () => {
    const dir = join(__dirname, '..', 'src', 'handlers');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/(?:ok|created)\(\{\s*devices?: ([^,}\n]+)/g)) {
        const expr = m[1].trim();
        // device-provisioning's one-shot credential bundle names the device by
        // id + thing only; it is not a Device object.
        const credentialBundle = f === 'device-provisioning.ts' && expr === '{ id: device.id';
        if (!/deviceResponse/.test(expr) && expr !== '[]' && !credentialBundle) {
          offenders.push(`${f}: ${expr}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
