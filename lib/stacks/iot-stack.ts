import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface XorgateCoreIotStackProps extends cdk.StackProps {
  stage: 'dev' | 'prod';
  bucket: s3.IBucket;
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
}

/**
 * IoT identity layer (P1): X.509 thing identity + credential provider (role alias)
 * so devices obtain short-lived AWS creds instead of static keys, plus a Cognito
 * Identity Pool that vends scoped browser creds (consumed by P2/P3).
 */
export class XorgateCoreIotStack extends cdk.Stack {
  public readonly thingTypeName: string;
  public readonly iotPolicyName: string;
  public readonly browserPolicyName: string;
  public readonly roleAliasName: string;
  public readonly identityPoolId: string;
  public readonly userPoolProviderName: string;

  constructor(scope: Construct, id: string, props: XorgateCoreIotStackProps) {
    super(scope, id, props);

    const { stage, bucket, userPool, userPoolClient } = props;
    const isProd = stage === 'prod';
    const nameSuffix = isProd ? '' : 'Dev';
    const slugSuffix = isProd ? '' : '-dev';

    const region = this.region;
    const account = this.account;

    this.thingTypeName = `xorgate-device${slugSuffix}`;
    this.iotPolicyName = `XorgateDevicePolicy${nameSuffix}`;
    this.browserPolicyName = `XorgateBrowserPolicy${nameSuffix}`;
    this.roleAliasName = `XorgateDeviceCreds${nameSuffix}`;
    this.userPoolProviderName = userPool.userPoolProviderName;

    const channelArnAll = `arn:aws:kinesisvideo:${region}:${account}:channel/*`;
    const roleAliasArn = `arn:aws:iot:${region}:${account}:rolealias/${this.roleAliasName}`;

    // --- IoT thing type ---
    new iot.CfnThingType(this, 'DeviceThingType', {
      thingTypeName: this.thingTypeName,
    });

    // --- Device credential-provider role (assumed via the role alias by the device cert) ---
    const deviceCredentialRole = new iam.Role(this, 'DeviceCredentialRole', {
      assumedBy: new iam.ServicePrincipal('credentials.iot.amazonaws.com'),
      description: 'Short-lived creds vended to devices via the IoT credential provider (KVS master + S3 segment upload)',
    });
    deviceCredentialRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'KvsMaster',
        actions: [
          'kinesisvideo:ConnectAsMaster',
          'kinesisvideo:GetSignalingChannelEndpoint',
          'kinesisvideo:DescribeSignalingChannel',
          'kinesisvideo:GetIceServerConfig',
        ],
        resources: [channelArnAll],
      }),
    );
    deviceCredentialRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3SegmentUpload', // used in P5; granted now
        actions: ['s3:PutObject'],
        resources: [
          bucket.arnForObjects('media/v1/*'),
          // Offline-recording segment uploads (offline_telemetry_video_recording
          // plan, D3): telemetry JSONL.gz now, video MP4 segments + sidecars in
          // Phase 4. Deliberately NOT under media/v1/ so the media-finalize rule
          // never sees segment objects.
          bucket.arnForObjects('telemetry/v1/*'),
          bucket.arnForObjects('media-sessions/v1/*'),
        ],
      }),
    );

    // --- IoT role alias -> credential role ---
    new iot.CfnRoleAlias(this, 'DeviceRoleAlias', {
      roleAlias: this.roleAliasName,
      roleArn: deviceCredentialRole.roleArn,
      credentialDurationSeconds: 3600,
    });

    // --- Base device IoT policy (single shared policy, per-device scoped via thing-name policy variables) ---
    const thingTopic = (segment: string) =>
      `arn:aws:iot:${region}:${account}:${segment}/xorgate/devices/\${iot:Connection.Thing.ThingName}`;
    new iot.CfnPolicy(this, 'DevicePolicy', {
      policyName: this.iotPolicyName,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'Connect',
            Effect: 'Allow',
            Action: 'iot:Connect',
            Resource: `arn:aws:iot:${region}:${account}:client/\${iot:Connection.Thing.ThingName}`,
          },
          {
            Sid: 'PublishReceive',
            Effect: 'Allow',
            Action: ['iot:Publish', 'iot:Receive'],
            Resource: `${thingTopic('topic')}/*`,
          },
          {
            Sid: 'Subscribe',
            Effect: 'Allow',
            Action: 'iot:Subscribe',
            Resource: `${thingTopic('topicfilter')}/*`,
          },
          {
            Sid: 'AssumeRoleWithCertificate',
            Effect: 'Allow',
            Action: 'iot:AssumeRoleWithCertificate',
            Resource: roleAliasArn,
          },
        ],
      },
    });

    // --- Browser IoT policy (attached to each Cognito identity via AttachPolicy) ---
    // AWS IoT does NOT authorize MQTT for Cognito-federated principals via their
    // IAM role policy — it requires an AWS IoT policy attached to the *identity*.
    // The backend `POST /iot/attach-policy` attaches this to the caller's identity.
    // v1 broad-but-authenticated (any authed user → any device telemetry); per-tenant
    // scoping via policy variables is the P7 hardening hook.
    new iot.CfnPolicy(this, 'BrowserPolicy', {
      policyName: this.browserPolicyName,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'Connect',
            Effect: 'Allow',
            Action: 'iot:Connect',
            Resource: `arn:aws:iot:${region}:${account}:client/*`,
          },
          {
            Sid: 'Subscribe',
            Effect: 'Allow',
            Action: 'iot:Subscribe',
            Resource: [
              `arn:aws:iot:${region}:${account}:topicfilter/xorgate/devices/*/telemetry`,
              // Workflow progress planes: simulator wf/sim/<orgId>/<runId>/...
              // (M3) and production runs wf/run/<orgId>/<runId>/... (M6).
              // Same v1 broad-but-authenticated stance as telemetry; per-org
              // scoping via policy variables is the P7 hardening hook.
              `arn:aws:iot:${region}:${account}:topicfilter/wf/sim/*`,
              `arn:aws:iot:${region}:${account}:topicfilter/wf/run/*`,
            ],
          },
          {
            Sid: 'Receive',
            Effect: 'Allow',
            Action: 'iot:Receive',
            Resource: [
              `arn:aws:iot:${region}:${account}:topic/xorgate/devices/*/telemetry`,
              `arn:aws:iot:${region}:${account}:topic/wf/sim/*`,
              `arn:aws:iot:${region}:${account}:topic/wf/run/*`,
            ],
          },
          {
            // M5 webcam ingest: the browser PUBLISHES sampled JPEG frames to
            // wf/sim/<orgId>/<runId>/ingest/<nodeId>. Publish is scoped to the
            // ingest suffix only, so a browser can never spoof the run's
            // status/steps/records topics.
            Sid: 'PublishIngest',
            Effect: 'Allow',
            Action: 'iot:Publish',
            Resource: [
              `arn:aws:iot:${region}:${account}:topic/wf/sim/*/ingest/*`,
            ],
          },
        ],
      },
    });

    // --- Cognito Identity Pool (browser temp creds; consumed by P2/P3) ---
    const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          providerName: userPool.userPoolProviderName,
          clientId: userPoolClient.userPoolClientId,
          serverSideTokenCheck: false,
        },
      ],
    });
    this.identityPoolId = identityPool.ref;

    const browserAuthRole = new iam.Role(this, 'IdentityPoolAuthRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPool.ref },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: 'Authenticated browser role: KVS viewer + IoT telemetry subscribe (v1 broad-but-authenticated)',
    });
    browserAuthRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'KvsViewer',
        actions: [
          'kinesisvideo:DescribeSignalingChannel',
          'kinesisvideo:GetSignalingChannelEndpoint',
          'kinesisvideo:GetIceServerConfig',
          'kinesisvideo:ConnectAsViewer',
        ],
        resources: [channelArnAll],
      }),
    );
    browserAuthRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'IotTelemetrySubscribe',
        actions: ['iot:Connect', 'iot:Subscribe', 'iot:Receive'],
        // v1: any authenticated user can subscribe to any device's telemetry
        // and any simulator progress topic. Per-tenant scoping (policy
        // variables / identity-scoped topics) is the P7 hardening hook.
        resources: [
          `arn:aws:iot:${region}:${account}:client/*`,
          `arn:aws:iot:${region}:${account}:topicfilter/xorgate/devices/*/telemetry`,
          `arn:aws:iot:${region}:${account}:topic/xorgate/devices/*/telemetry`,
          `arn:aws:iot:${region}:${account}:topicfilter/wf/sim/*`,
          `arn:aws:iot:${region}:${account}:topic/wf/sim/*`,
          `arn:aws:iot:${region}:${account}:topicfilter/wf/run/*`,
          `arn:aws:iot:${region}:${account}:topic/wf/run/*`,
        ],
      }),
    );
    browserAuthRole.addToPolicy(
      new iam.PolicyStatement({
        // M5 webcam ingest publish (mirrors the IoT browser policy's
        // PublishIngest statement; both layers must allow it).
        sid: 'IotSimIngestPublish',
        actions: ['iot:Publish'],
        resources: [`arn:aws:iot:${region}:${account}:topic/wf/sim/*/ingest/*`],
      }),
    );

    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoles', {
      identityPoolId: identityPool.ref,
      roles: { authenticated: browserAuthRole.roleArn },
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'IotThingTypeName', { value: this.thingTypeName });
    new cdk.CfnOutput(this, 'IotPolicyName', { value: this.iotPolicyName });
    new cdk.CfnOutput(this, 'IotRoleAlias', { value: this.roleAliasName });
    new cdk.CfnOutput(this, 'IdentityPoolId', { value: this.identityPoolId });
  }
}
