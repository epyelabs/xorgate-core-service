import { describe, expect, it } from 'vitest';
import {
  namespaceAllowedFor,
  SIMULATION_DEFAULTS,
  validateConfigPatch,
  validateNamespaceValue,
} from '../src/config-registry/index';
import { buildDeviceConfigMessage } from '../src/services/device-config';

/**
 * The `simulation` namespace (plans/xorgate-device-simulator, README §3.3):
 * a strict, whole-replace namespace that ONLY a simulated device may hold.
 */
describe('simulation namespace', () => {
  const full = { scenarioId: 'parked-2026-09-17', loop: false, gapSeconds: 0 };

  it('accepts the full shape and the defaults', () => {
    expect(validateNamespaceValue('simulation', full)).toEqual({ value: full });
    expect(validateNamespaceValue('simulation', { ...SIMULATION_DEFAULTS })).toEqual({
      value: SIMULATION_DEFAULTS,
    });
  });

  it('requires all three fields (replace-whole: a partial would reset the others)', () => {
    expect(validateNamespaceValue('simulation', { scenarioId: 'city-2026-09-27' })).toHaveProperty('error');
    expect(validateNamespaceValue('simulation', {})).toHaveProperty('error');
  });

  it('bounds gapSeconds to 0..3600 integers', () => {
    for (const gapSeconds of [-1, 3601, 1.5]) {
      expect(validateNamespaceValue('simulation', { ...full, gapSeconds })).toHaveProperty('error');
    }
    expect(validateNamespaceValue('simulation', { ...full, gapSeconds: 3600 })).toHaveProperty('value');
  });

  it('pins scenarioId to the catalog id alphabet', () => {
    for (const scenarioId of ['', 'City', '-lead', '../etc', 'a'.repeat(65), 'with space']) {
      expect(validateNamespaceValue('simulation', { ...full, scenarioId })).toHaveProperty('error');
    }
    expect(validateNamespaceValue('simulation', { ...full, scenarioId: 'a'.repeat(64) })).toHaveProperty('value');
  });

  it('is strict about unknown keys', () => {
    expect(validateNamespaceValue('simulation', { ...full, speed: 2 })).toHaveProperty('error');
  });
});

describe('simulation namespace — simulated devices only', () => {
  const patch = { simulation: { scenarioId: 'city-2026-09-27', loop: true, gapSeconds: 30 } };

  it('is refused for a real device (the default), even alongside a valid namespace', () => {
    const r = validateConfigPatch({ ...patch, timeSync: { offlineSources: false } });
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('simulation');
    expect(validateConfigPatch(patch, { simulated: false })).toHaveProperty('error');
    // Clearing it is a write too: refused for real hardware as well.
    expect(validateConfigPatch({ simulation: null })).toHaveProperty('error');
  });

  it('is accepted for a simulated device', () => {
    expect(validateConfigPatch(patch, { simulated: true })).toEqual({ value: patch });
  });

  it('leaves every other namespace writable on a real device', () => {
    expect(validateConfigPatch({ timeSync: { offlineSources: false } })).toHaveProperty('value');
    expect(namespaceAllowedFor('recording', {})).toBe(true);
    expect(namespaceAllowedFor('simulation', {})).toBe(false);
    expect(namespaceAllowedFor('simulation', { simulated: true })).toBe(true);
  });

  it('is published after cameraMount, in registry order, when the document carries it', () => {
    const msg = buildDeviceConfigMessage(
      { recording: { video: { cameras: { cam1: false } } }, simulation: patch.simulation },
      1,
      0,
    ) as Record<string, unknown>;
    expect(msg.simulation).toEqual(patch.simulation);
    const keys = Object.keys(msg);
    expect(keys.indexOf('simulation')).toBeGreaterThan(keys.indexOf('recording'));
  });

  it('is never published for a document that does not carry it', () => {
    const msg = buildDeviceConfigMessage({}, 1, 0) as Record<string, unknown>;
    expect(msg).not.toHaveProperty('simulation');
  });
});
