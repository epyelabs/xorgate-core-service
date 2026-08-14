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
  public readonly liveVendRoleName: string;
  public readonly liveVendRoleArn: string;

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
          // Offline-recording segment uploads (offline_telemetry_video_recording
          // plan, D3): telemetry JSONL.gz and video MP4 segments + sidecars.
          // (The recorder-era media/v1/* prefix was dropped in
          // destroy-kvs-recorder Phase 5 — nothing writes there any more.)
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
            // The tenant-scoped telemetry topic (platform-auth Phase 4). The
            // historical topic above carries no organization and no workspace,
            // so no topic-pattern IAM policy can express a tenant boundary over
            // it, and a third party's credential therefore could not be scoped
            // at all. Devices publish here instead.
            //
            // The scope comes from THING ATTRIBUTES rather than from the
            // message, which is what makes it enforcement rather than a
            // convention: the backend writes `xgOrgId`/`xgWorkspaceId` onto the
            // thing (`services/device-scope.ts`) and a device can only ever
            // publish under its own. A device whose attributes are unset — one
            // provisioned before this phase and not yet reached by a config
            // publish — resolves the variables to nothing and is refused, so it
            // stays on the topic above. Fails closed, and the fleet migrates
            // one device at a time rather than on a flag day.
            Sid: 'PublishScopedTelemetry',
            Effect: 'Allow',
            Action: 'iot:Publish',
            Resource:
              `arn:aws:iot:${region}:${account}:topic/xorgate/orgs/` +
              '${iot:Connection.Thing.Attributes[xgOrgId]}/ws/' +
              '${iot:Connection.Thing.Attributes[xgWorkspaceId]}/devices/' +
              '${iot:Connection.Thing.ThingName}/telemetry',
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

    // Browser MQTT client ids are scoped to the caller's own Cognito identity id
    // (`<identityId>-<role>-<uuid>`; see frontend/xorgate-web/src/lib/iot-wss.ts
    // `browserClientId`). The trailing `*` is load-bearing: one identity needs
    // SEVERAL concurrent connections (telemetry feed, workflow-run progress,
    // webcam ingest, and one per open tab — two tabs of the same user resolve to
    // the SAME identity id, verified 2026-08-13), and an exact-match resource
    // would make them displace each other the way devices are displaced today.
    // Device ids are bare UUIDs and can never carry the `us-east-1:` identity
    // prefix, so no browser client id can collide with a thing name.
    const browserClientArn = `arn:aws:iot:${region}:${account}:client/\${cognito-identity.amazonaws.com:sub}*`;

    // --- Browser IoT policy (attached to each Cognito identity via AttachPolicy) ---
    // AWS IoT does NOT authorize MQTT for Cognito-federated principals via their
    // IAM role policy — it requires an AWS IoT policy attached to the *identity*.
    // The backend `POST /iot/attach-policy` attaches this to the caller's identity.
    // Connect is identity-scoped (platform-auth-and-live-plane Phase 1); Subscribe
    // and Receive are still broad-but-authenticated (any authed user → any device
    // telemetry), which Phase 4 narrows. Publish was already scoped to the
    // workflow-simulator ingest suffix.
    new iot.CfnPolicy(this, 'BrowserPolicy', {
      policyName: this.browserPolicyName,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'Connect',
            Effect: 'Allow',
            Action: 'iot:Connect',
            Resource: browserClientArn,
          },
          {
            Sid: 'Subscribe',
            Effect: 'Allow',
            Action: 'iot:Subscribe',
            Resource: [
              `arn:aws:iot:${region}:${account}:topicfilter/xorgate/devices/*/telemetry`,
              // The tenant-scoped telemetry plane devices move onto
              // (platform-auth Phase 4). Same broad-but-authenticated stance as
              // the line above and for the same reason: the first-party
              // dashboard is org-blind here, and narrowing it is 4.3's decision
              // rather than this one's. The browser subscribes to BOTH while
              // the fleet crosses over, so both have to be allowed.
              `arn:aws:iot:${region}:${account}:topicfilter/xorgate/orgs/*/ws/*/devices/*/telemetry`,
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
              `arn:aws:iot:${region}:${account}:topic/xorgate/orgs/*/ws/*/devices/*/telemetry`,
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
        // A Cognito-federated principal's effective MQTT permission is the
        // INTERSECTION of this role policy and the IoT policy attached to the
        // identity, so Connect is scoped in both places rather than relying on
        // the attached policy alone. Subscribe/Receive stay broad-but-
        // authenticated (any authed user → any device's telemetry and any
        // workflow progress topic); narrowing those is Phase 4's job.
        resources: [
          browserClientArn,
          `arn:aws:iot:${region}:${account}:topicfilter/xorgate/devices/*/telemetry`,
          `arn:aws:iot:${region}:${account}:topic/xorgate/devices/*/telemetry`,
          // The scoped plane, in BOTH layers. A Cognito-federated principal's
          // MQTT permission is the INTERSECTION of this role policy and the
          // attached IoT policy (Phase 1 found this the hard way), so adding it
          // to only one of them silently authorizes nothing.
          `arn:aws:iot:${region}:${account}:topicfilter/xorgate/orgs/*/ws/*/devices/*/telemetry`,
          `arn:aws:iot:${region}:${account}:topic/xorgate/orgs/*/ws/*/devices/*/telemetry`,
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

    // --- Scoped live-credential vending role (platform-auth Phase 4) ---
    //
    // The credential a third party's browser gets for the live plane. It is a
    // plain STS assumed role, NOT a Cognito identity, which is the whole point:
    // an assumed role's MQTT authorization is its IAM policy alone (no attached
    // AWS IoT policy is involved), so `AssumeRole`'s inline session policy — the
    // thing `GetCredentialsForIdentity` does not have, and the constraint design
    // note N2 recorded — becomes available as the per-request narrowing
    // mechanism.
    //
    // This role is therefore the CEILING, not the grant: every vend narrows it
    // with a session policy naming one organization and (optionally) one
    // workspace, and the effective permission is the intersection. Nothing here
    // may be broader than "some xorgate tenant's live plane".
    //
    // `roleName` is fixed so the api-stack can build the ARN without a
    // cross-stack export cycle (this stack is created before the api stack and
    // the Lambda execution role lives over there).
    this.liveVendRoleName = `XorgateLiveVend${nameSuffix}`;
    this.liveVendRoleArn = `arn:aws:iam::${account}:role/${this.liveVendRoleName}`;

    const liveVendRole = new iam.Role(this, 'LiveVendRole', {
      roleName: this.liveVendRoleName,
      // Delegated to the account: any principal here that ALSO carries
      // `sts:AssumeRole` on this ARN in its own identity policy may vend. The
      // api-stack grants exactly that to the shared Lambda execution role and
      // to nothing else, so the identity policy is the real gate.
      assumedBy: new iam.AccountPrincipal(account),
      maxSessionDuration: cdk.Duration.hours(1),
      description:
        'Ceiling role for scoped live-plane credentials. Every vend narrows it ' +
        'with an inline session policy naming one org/workspace.',
    });

    liveVendRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LiveConnect',
        actions: ['iot:Connect'],
        // Vended client ids are `xgl-<uuid>`. The prefix cannot collide with a
        // thing name (device ids are bare UUIDs) nor with a browser client id
        // (those start `us-east-1:`), so a vended credential can never displace
        // a device's or a first-party browser's MQTT session.
        resources: [`arn:aws:iot:${region}:${account}:client/xgl-*`],
      }),
    );
    liveVendRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LiveTelemetrySubscribe',
        actions: ['iot:Subscribe', 'iot:Receive'],
        resources: [
          `arn:aws:iot:${region}:${account}:topicfilter/xorgate/orgs/*/ws/*/devices/*/telemetry`,
          `arn:aws:iot:${region}:${account}:topic/xorgate/orgs/*/ws/*/devices/*/telemetry`,
        ],
      }),
    );
    liveVendRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LiveVideoViewer',
        actions: [
          'kinesisvideo:DescribeSignalingChannel',
          'kinesisvideo:GetSignalingChannelEndpoint',
          'kinesisvideo:GetIceServerConfig',
          'kinesisvideo:ConnectAsViewer',
        ],
        // Narrowed per vend to the caller's own devices' channels by the session
        // policy. No `ConnectAsMaster` and no channel mutation, matching the
        // browser role: a viewer credential can watch and can change nothing.
        resources: [channelArnAll],
      }),
    );

    // Prototype escape hatch, OFF unless asked for explicitly on the command
    // line (`--context probeTrust=<iam-arn>`), dev only, and self-clearing: a
    // plain `npm run deploy:dev` passes no such context and removes whatever a
    // probe run added. It exists so the Phase 4 mechanism evaluation could
    // assume this role from a workstation and speak MQTT/KVS directly, instead
    // of round-tripping every measurement through a deployed Lambda. Nothing in
    // the product depends on it; delete the block if it stops being useful.
    const probeTrust = this.node.tryGetContext('probeTrust') as string | undefined;
    if (probeTrust && !isProd) {
      liveVendRole.assumeRolePolicy?.addStatements(
        new iam.PolicyStatement({
          sid: 'ProbeTrust',
          principals: [new iam.ArnPrincipal(probeTrust)],
          actions: ['sts:AssumeRole', 'sts:TagSession'],
        }),
      );
    }

    new cdk.CfnOutput(this, 'LiveVendRoleArn', { value: liveVendRole.roleArn });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'IotThingTypeName', { value: this.thingTypeName });
    new cdk.CfnOutput(this, 'IotPolicyName', { value: this.iotPolicyName });
    new cdk.CfnOutput(this, 'IotRoleAlias', { value: this.roleAliasName });
    new cdk.CfnOutput(this, 'IdentityPoolId', { value: this.identityPoolId });
  }
}
