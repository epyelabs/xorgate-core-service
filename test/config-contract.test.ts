import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildConfigContract, serializeConfigContract } from '../src/config-registry/contract';
import {
  CONFIG_NAMESPACES,
  UI_PREFS_DEFAULTS,
  uiPrefsSchema,
} from '../src/config-registry/index';

const ARTIFACT = join(__dirname, '..', 'src', 'config-registry', 'config-contract.json');

describe('config-contract.json', () => {
  it('matches the registry (run `npm run contract:generate` after editing it)', () => {
    // THE staleness guard. The frontend imports this artifact for its defaults
    // and the device agent contract-tests its own constants against it, so a
    // registry edit that never reached the artifact would silently un-sync all
    // three packages — which is exactly how the thermal-shed keys drifted.
    expect(readFileSync(ARTIFACT, 'utf8')).toBe(serializeConfigContract());
  });

  it('publishes defaults + bounds + enums for every namespace', () => {
    const contract = buildConfigContract();
    for (const ns of CONFIG_NAMESPACES) {
      const entry = contract.namespaces[ns.key];
      expect(entry, ns.key).toBeDefined();
      expect(entry.defaults, `${ns.key} defaults`).toBeDefined();
      expect(entry.jsonSchema, `${ns.key} jsonSchema`).toBeDefined();
      expect(entry.applyClass).toBe(ns.applyClass);
    }
  });

  it('carries the recording bounds the UI and the device both rely on', () => {
    const recording = buildConfigContract().namespaces.recording.jsonSchema as {
      properties: Record<string, { properties: Record<string, Record<string, unknown>> }>;
    };
    expect(recording.properties.video.properties.preset.enum).toEqual([
      '1080p30-4mbps',
      '1080p15-2mbps',
      '720p30-2mbps',
      '720p15-2mbps',
      '720p15-1mbps',
    ]);
    expect(recording.properties.telemetry.properties.rateHz.minimum).toBe(1);
    expect(recording.properties.telemetry.properties.rateHz.maximum).toBe(20);
    // The three keys whose absence from the generated docs was the drift.
    const shed = recording.properties.powerShedding.properties;
    expect(Object.keys(shed)).toEqual(
      expect.arrayContaining(['cpuTempC', 'cpuTempRestoreC', 'cpuTempSecs']),
    );
  });

  it('states the wire version the device parses', () => {
    expect(buildConfigContract().wireVersion).toBe(1);
  });

  it('every published default is itself valid against its namespace schema', () => {
    // The web app renders these defaults for an unconfigured device and casts
    // the string ones to its union types on import; the device agent asserts
    // its own constants against them. A default outside its own enum/bounds
    // would be a value no save could ever reproduce.
    for (const ns of CONFIG_NAMESPACES) {
      const parsed = ns.schema.safeParse(ns.defaults);
      expect(parsed.success, `${ns.key} defaults: ${JSON.stringify(parsed)}`).toBe(true);
    }
    expect(uiPrefsSchema.safeParse(UI_PREFS_DEFAULTS).success).toBe(true);
  });
});
