import { PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { iotDataClient } from './iot-data';

/**
 * Cloud -> device config delivery. Publishes the device's full config object
 * to `xorgate/devices/{deviceId}/config` with the MQTT retain flag, so an
 * offline device receives the latest config on its next connect — no shadow
 * service or reconciliation loop. The payload is the complete config (not a
 * delta) so redelivery is idempotent and self-contained.
 *
 * The device IoT policy already allows subscribe/receive on
 * `xorgate/devices/${thingName}/*` (thingName = deviceId), so no policy change
 * is needed device-side. The Lambda role needs `iot:Publish` on the config
 * topic (granted in api-stack.ts).
 */

export interface ImuMountConfig {
  enabled: boolean;
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
}

/** The README `recording` settings shape (offline recording plan, D7). */
export interface RecordingConfigMessage {
  telemetry?: { enabled?: boolean; rateHz?: number };
  video?: {
    enabled?: boolean;
    preset?: string;
    segmentSeconds?: number;
    // Boot power staging (optimize-system-process-cycle plan, Phase 2).
    bootDefer?: 'auto' | 'always' | 'off';
    bootDeferMaxSecs?: number;
    bootDeferMinBudgetMa?: number;
    spawnStaggerSecs?: number;
  };
  upload?: { mode?: 'auto' | 'off' };
  retention?: { maxBytes?: number; minFreeBytes?: number };
}

/** LTE recovery policy shape (lte_gnss_recovery plan, R8). */
export interface LteRecoveryConfigMessage {
  gpsFixResetPolicy?: 'defer' | 'veto-deadzone';
  deadZoneProfile?: 'conservative' | 'balanced' | 'aggressive';
}

export interface DeviceConfigMessage {
  v: 1;
  gnssAntBias: boolean;
  /** Omitted (not null) when the device has never had a mount configured. */
  imuMount?: ImuMountConfig;
  /**
   * On-device recording config (offline recording plan, Phase 5). Omitted when
   * `devices.recording_config` is NULL — the device then keeps its local
   * settings untouched; when present the agent REPLACES its settings.json
   * `recording` namespace with this value (cloud is authoritative once set).
   */
  recording?: RecordingConfigMessage;
  /**
   * LTE recovery policy (lte_gnss_recovery plan, R8). Omitted when
   * `devices.lte_recovery_config` is NULL — the device then keeps its local
   * settings; when present the agent REPLACES its settings.json `lteRecovery`
   * namespace with this value (cloud is authoritative once set). The
   * sim7600-lte daemon re-reads the file at each recovery decision, so a
   * change applies without any device restart.
   */
  lteRecovery?: LteRecoveryConfigMessage;
  /**
   * Segment-upload S3 bucket (offline recording plan, Phase 6.2). The install
   * script writes this into kvs.json for NEW devices; carrying it on the
   * retained config message backfills devices fielded before Phase 2 (the
   * agent persists it into kvs.json and arms its uploader live). Sourced from
   * the Lambda's BUCKET_NAME env; omitted if that is unset.
   */
  uploadBucket?: string;
  ts: number;
}

/** Publish the retained per-device config message. Throws on failure. */
export async function publishDeviceConfig(
  deviceId: string,
  config: {
    gnssAntBias: boolean;
    imuMount?: ImuMountConfig | null;
    recording?: RecordingConfigMessage | null;
    lteRecovery?: LteRecoveryConfigMessage | null;
  },
): Promise<void> {
  const uploadBucket = process.env.BUCKET_NAME;
  const message: DeviceConfigMessage = {
    v: 1,
    gnssAntBias: config.gnssAntBias,
    ...(config.imuMount ? { imuMount: config.imuMount } : {}),
    ...(config.recording ? { recording: config.recording } : {}),
    ...(config.lteRecovery ? { lteRecovery: config.lteRecovery } : {}),
    ...(uploadBucket ? { uploadBucket } : {}),
    ts: Date.now(),
  };
  const client = await iotDataClient();
  await client.send(
    new PublishCommand({
      topic: `xorgate/devices/${deviceId}/config`,
      qos: 1,
      retain: true,
      payload: Buffer.from(JSON.stringify(message)),
    }),
  );
}
