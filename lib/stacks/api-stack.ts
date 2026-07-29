import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2int from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import * as lambdaDestinations from "aws-cdk-lib/aws-lambda-destinations";
import * as iot from "aws-cdk-lib/aws-iot";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import * as path from "path";

export interface XorgateCoreApiStackProps extends cdk.StackProps {
  stage: "dev" | "prod";
  // When true, EventBridge-scheduled jobs (OfflineSweeper) are deployed but
  // disabled. They poll the shared sandbox Aurora via the Data API and block
  // its auto-pause; defaults off in dev (see bin/app.ts).
  disableScheduledJobs?: boolean;
  bucket: s3.Bucket;
  // Public-read bucket holding device-agent tarballs; its URL is baked into the
  // per-request install.sh so devices can download the build without AWS creds.
  distBucket: s3.Bucket;
  dbCluster?: rds.DatabaseCluster;
  dbClusterArn?: string;
  dbSecret?: secretsmanager.ISecret;
  dbSecretName?: string;
  dbSecurityGroup?: ec2.SecurityGroup;
  dbName: string;
  vpc?: ec2.Vpc;
  userPoolId: string;
  userPoolClientId: string;
  iotThingTypeName: string;
  iotPolicyName: string;
  browserIotPolicyName: string;
  iotRoleAlias: string;
  cognitoIdentityPoolId: string;
  cognitoUserPoolProvider: string;
  // Shared Fargate cluster/network — see recorder-stack.ts. Historic `recorder`
  // naming; the engine runner is the only thing that launches here now (the
  // cloud viewer-recorder's four task-only props went in Phase 5).
  recorderClusterArn: string;
  recorderClusterName: string;
  recorderSecurityGroupId: string;
  recorderSubnets: string; // comma-separated public subnet ids
  // v2 engine runner launch config — shares the recorder cluster/VPC/SG. Since
  // the M6 cutover this is the ONLY workflow execution plane (the Python
  // cv-runner and its CV_* wiring are retired).
  engineTaskFamily: string;
  engineTaskRoleArn: string;
  engineExecutionRoleArn: string;
  engineContainerName: string;
}

export class XorgateCoreApiStack extends cdk.Stack {
  public readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: XorgateCoreApiStackProps) {
    super(scope, id, props);

    const {
      stage,
      vpc,
      bucket,
      distBucket,
      dbCluster,
      dbClusterArn: dbClusterArnProp,
      dbSecret: dbSecretProp,
      dbSecretName,
      dbSecurityGroup,
      dbName,
      userPoolId,
      userPoolClientId,
      iotThingTypeName,
      iotPolicyName,
      browserIotPolicyName,
      iotRoleAlias,
      cognitoIdentityPoolId,
      cognitoUserPoolProvider,
      recorderClusterArn,
      recorderClusterName,
      recorderSecurityGroupId,
      recorderSubnets,
      engineTaskFamily,
      engineTaskRoleArn,
      engineExecutionRoleArn,
      engineContainerName,
    } = props;

    const isProd = stage === "prod";
    const exportSuffix = isProd ? "" : "Dev";

    const clusterArn = dbCluster?.clusterArn ?? dbClusterArnProp;
    if (!clusterArn) {
      throw new Error(
        "XorgateCoreApiStack: dbCluster or dbClusterArn must be set",
      );
    }

    const dbSecret: secretsmanager.ISecret =
      dbSecretProp ??
      (dbSecretName
        ? secretsmanager.Secret.fromSecretNameV2(
            this,
            "DbSecretLookup",
            dbSecretName,
          )
        : (() => {
            throw new Error(
              "XorgateCoreApiStack: dbSecret or dbSecretName must be set",
            );
          })());

    const allowedOrigins: string[] = [
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
      "https://xorgate.ai",
      "http://dev.xorgate.io.s3-website-us-east-1.amazonaws.com",
      "http://www.xorgate.io.s3-website-us-east-1.amazonaws.com",
      "https://d3u971sluio616.cloudfront.net",
      "https://dev.xorgate.io",
      "https://www.xorgate.io",
    ];

    let lambdaSG: ec2.SecurityGroup | undefined;
    if (vpc) {
      lambdaSG = new ec2.SecurityGroup(this, "LambdaSG", {
        vpc,
        description: "Xorgate Lambda functions security group",
        allowAllOutbound: true,
      });

      if (dbSecurityGroup) {
        new ec2.CfnSecurityGroupIngress(this, "DbFromLambda", {
          groupId: dbSecurityGroup.securityGroupId,
          ipProtocol: "tcp",
          fromPort: 5432,
          toPort: 5432,
          sourceSecurityGroupId: lambdaSG.securityGroupId,
        });
      }
    }

    const lambdaRole = new iam.Role(this, "LambdaExecutionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Shared execution role for all Xorgate Lambda functions",
      managedPolicies: vpc
        ? [
            iam.ManagedPolicy.fromAwsManagedPolicyName(
              "service-role/AWSLambdaVPCAccessExecutionRole",
            ),
          ]
        : [],
    });

    bucket.grantReadWrite(lambdaRole);

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "rds-data:ExecuteStatement",
          "rds-data:BatchExecuteStatement",
          "rds-data:BeginTransaction",
          "rds-data:CommitTransaction",
          "rds-data:RollbackTransaction",
        ],
        resources: [clusterArn],
      }),
    );

    dbSecret.grantRead(lambdaRole);

    // Device provisioning (P1): mint IoT thing/cert, attach the base policy, create KVS channels.
    // Resource authorization is per-action: AttachThingPrincipal checks BOTH the thing and the
    // certificate; AttachPolicy/UpdateCertificate check the certificate. Grant these on both ARNs.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "IotProvisioning",
        actions: [
          "iot:CreateThing",
          "iot:DescribeThing",
          "iot:AttachThingPrincipal",
          "iot:AttachPolicy",
          "iot:UpdateCertificate",
          // Used only on the device-registration claim rollback path: tear down a
          // half-provisioned thing/cert so a failed claim leaves no orphans.
          "iot:ListThingPrincipals",
          "iot:DetachThingPrincipal",
          "iot:DetachPolicy",
          "iot:DeleteCertificate",
          "iot:DeleteThing",
        ],
        resources: [
          `arn:aws:iot:${this.region}:${this.account}:thing/*`,
          `arn:aws:iot:${this.region}:${this.account}:cert/*`,
        ],
      }),
    );
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        // CreateKeysAndCertificate / DescribeEndpoint do not support resource-level scoping.
        sid: "IotCreateKeysAndEndpoint",
        actions: ["iot:CreateKeysAndCertificate", "iot:DescribeEndpoint"],
        resources: ["*"],
      }),
    );
    // Device config delivery: the devices handler publishes a retained config
    // message (e.g. the GNSS antenna-bias toggle) to the per-device config topic
    // after a successful update. DescribeEndpoint (needed to resolve the ATS data
    // endpoint) is already granted above.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "IotPublishDeviceConfig",
        // RetainPublish is required IN ADDITION to Publish when the RETAIN
        // flag is set (the config message is retained so offline devices
        // receive it on next connect).
        actions: ["iot:Publish", "iot:RetainPublish"],
        resources: [
          `arn:aws:iot:${this.region}:${this.account}:topic/xorgate/devices/*/config`,
        ],
      }),
    );
    // One-shot device commands (reboot / power-off). Separate from the config
    // grant above because commands are deliberately NOT retained — a retained
    // reboot would replay on every reconnect and boot-loop the device — so this
    // statement withholds iot:RetainPublish. Keep it that way.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "IotPublishDeviceCommand",
        actions: ["iot:Publish"],
        resources: [
          `arn:aws:iot:${this.region}:${this.account}:topic/xorgate/devices/*/command`,
        ],
      }),
    );
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "KvsChannels",
        actions: [
          "kinesisvideo:CreateSignalingChannel",
          "kinesisvideo:DescribeSignalingChannel",
        ],
        resources: [`arn:aws:kinesisvideo:${this.region}:${this.account}:channel/*`],
      }),
    );

    // Stop/inspect tasks in the SHARED Fargate cluster. Kept — rescoped from
    // the cloud recorder to the engine — when destroy-kvs-recorder Phase 5
    // deleted RecorderRunTask/RecorderPassRole: workflow-scheduler.ts stops
    // stale engine-runner tasks and workflow-engine-v2.ts lists/describes them.
    // The resource is the shared cluster's task space, so the ARN is unchanged.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "EngineStopTask",
        actions: ["ecs:StopTask", "ecs:DescribeTasks"],
        resources: [
          `arn:aws:ecs:${this.region}:${this.account}:task/${recorderClusterName}/*`,
        ],
      }),
    );

    // (CvRunTask/CvPassRole retired in M6 with the Python cv-runner: the
    // shared Lambda role can no longer launch the CV task definition at all.)

    // v2 engine runner (M2): launch + pass roles on the shared Fargate
    // cluster (StopTask/DescribeTasks already covered by EngineStopTask).
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "EngineRunTask",
        actions: ["ecs:RunTask"],
        resources: [
          `arn:aws:ecs:${this.region}:${this.account}:task-definition/${engineTaskFamily}:*`,
        ],
      }),
    );
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "EnginePassRole",
        actions: ["iam:PassRole"],
        resources: [engineTaskRoleArn, engineExecutionRoleArn],
        conditions: {
          StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
        },
      }),
    );

    // Progress planes: the v2 Lambda engine publishes simulator progress to
    // wf/sim/<orgId>/<runId>/* (M3) and production run progress to
    // wf/run/<orgId>/<runId>/* (M6). The engine TASK role gets the same grants
    // in recorder-stack.ts. Literal ARNs, no construct references (shared-role
    // rule).
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "IotPublishSimProgress",
        actions: ["iot:Publish"],
        resources: [
          `arn:aws:iot:${this.region}:${this.account}:topic/wf/sim/*`,
          `arn:aws:iot:${this.region}:${this.account}:topic/wf/run/*`,
        ],
      }),
    );
    // Google Roads connector API key (secret created OUT-OF-BAND; deploy
    // constraint). Name-based wildcard: Secrets Manager suffixes the ARN.
    const googleRoadsSecretName = isProd
      ? "xorgate-google-roads-api-key"
      : "xorgate-google-roads-api-key-dev";
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "GoogleRoadsSecretRead",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${googleRoadsSecretName}*`,
        ],
      }),
    );
    // Anthropic API key for model.vlm (M5): same out-of-band-secret pattern as
    // the Roads key, readable by both engine roles (the task role gets it in
    // recorder-stack.ts). The Lambda engine never runs media graphs, but the
    // grant keeps the two targets symmetric per the M5 plan.
    const anthropicSecretName = isProd
      ? "xorgate-anthropic-api-key"
      : "xorgate-anthropic-api-key-dev";
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AnthropicSecretRead",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${anthropicSecretName}*`,
        ],
      }),
    );
    // Optional platform-level HERE key (M7): same out-of-band pattern. The env
    // var is always wired; while the secret does not exist the engine surfaces
    // its clear "does not exist" failure and org keys still work.
    const hereSecretName = isProd
      ? "xorgate-here-api-key"
      : "xorgate-here-api-key-dev";
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "HereSecretRead",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${hereSecretName}*`,
        ],
      }),
    );
    // Per-org connector credentials (M7): xorgate/orgs/<orgId>/<provider>.
    // GetSecretValue serves the Lambda engine's org-first resolution; the
    // Create/Put/Delete/Describe actions serve the org-settings handler. Name-
    // pattern grant (no per-org literal ARNs exist at deploy time); the engine
    // TASK role gets the read-only twin in recorder-stack.ts.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "OrgCredentialSecrets",
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:DeleteSecret",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:xorgate/orgs/*`,
        ],
      }),
    );
    // Warm simulator sessions (M5): the simulations handler creates/sends to
    // per-editing-session SQS queues and looks for a running session task
    // before launching one (ecs:ListTasks is cluster-conditioned; its resource
    // type is container-instance, so the resource must stay "*").
    const sessionQueuePrefix = isProd ? "xorgate-wfsim-prod-" : "xorgate-wfsim-dev-";
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "WfSessionQueues",
        actions: ["sqs:CreateQueue", "sqs:SendMessage", "sqs:GetQueueUrl"],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:${sessionQueuePrefix}*`,
        ],
      }),
    );
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "WfSessionListTasks",
        actions: ["ecs:ListTasks"],
        resources: ["*"], // resource type is container-instance; scope by cluster
        conditions: {
          ArnEquals: { "ecs:cluster": recorderClusterArn },
        },
      }),
    );

    // Browser live-telemetry (P2): attach the AWS IoT policy to a caller's Cognito
    // identity so the browser can connect/subscribe over MQTT-over-WSS. iot:AttachPolicy
    // authorizes against the *target* (a Cognito identity id, not an ARN) → resource "*";
    // the handler only ever attaches the fixed BROWSER_IOT_POLICY_NAME.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "IotAttachBrowserPolicy",
        actions: ["iot:AttachPolicy"],
        resources: ["*"],
      }),
    );
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CognitoGetId",
        actions: ["cognito-identity:GetId"],
        resources: [
          `arn:aws:cognito-identity:${this.region}:${this.account}:identitypool/${cognitoIdentityPoolId}`,
        ],
      }),
    );

    // Invited-member provisioning: admin-create a Cognito account for an email
    // that has no user yet (POST /memberships), and look one up on the
    // already-exists path. Cognito emails the invitee a temporary password.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CognitoAdminInviteUser",
        actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"],
        resources: [
          `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${userPoolId}`,
        ],
      }),
    );

    lambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AWSLambdaBasicExecutionRole",
      ),
    );

    // Read a recording-threshold override from CDK context, else use the default.
    // Lets an operator retune any threshold at deploy (`--context key=value`)
    // without a code edit (kvs-webrtc-lts G5).
    const recCtx = (key: string, def: string): string => {
      const v = this.node.tryGetContext(key);
      return v === undefined || v === null ? def : String(v);
    };

    const commonEnv: Record<string, string> = {
      NODE_ENV: isProd ? "production" : "development",
      DB_CLUSTER_ARN: clusterArn,
      DB_SECRET_ARN: dbSecret.secretArn,
      DB_NAME: dbName,
      BUCKET_NAME: bucket.bucketName,
      COGNITO_USER_POOL_ID: userPoolId,
      COGNITO_CLIENT_ID: userPoolClientId,
      IOT_THING_TYPE_NAME: iotThingTypeName,
      IOT_POLICY_NAME: iotPolicyName,
      BROWSER_IOT_POLICY_NAME: browserIotPolicyName,
      IOT_ROLE_ALIAS: iotRoleAlias,
      COGNITO_IDENTITY_POOL_ID: cognitoIdentityPoolId,
      COGNITO_USER_POOL_PROVIDER: cognitoUserPoolProvider,
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
      // Shared Fargate cluster/network. Historic RECORDER_* names (the cloud
      // recorder that owned them is gone): RECORDER_CLUSTER_ARN is read
      // directly by src/handlers/workflow-scheduler.ts, and all three are
      // re-exported below as the engine's ENGINE_* wiring. Renaming them is
      // out of scope (README §10).
      RECORDER_CLUSTER_ARN: recorderClusterArn,
      RECORDER_SUBNETS: recorderSubnets,
      RECORDER_SG: recorderSecurityGroupId,
      // Device-status / sweeper thresholds, read by src/config/recording.ts.
      // Defaults preserve today's behavior; override any at deploy via `--context <key>=<val>`.
      STATUS_FLAP_GUARD_MS: recCtx("statusFlapGuardMs", "10000"),
      DEVICE_OFFLINE_STALE_MS: recCtx("deviceOfflineStaleMs", "60000"),
      // Device-recorded segment retention (offline recording plan, Phase 6.3).
      // Drives the sweeper's DB row expiry; MUST match the S3 lifecycle age in
      // storage-stack — both read the `segmentRetentionDays` context key.
      SEGMENT_RETENTION_DAYS: recCtx("segmentRetentionDays", "90"),
      // Device-recorded media sessions (offline recording plan, Phase 4):
      // sweeper close window — no new segment ARRIVAL for this long -> closed.
      MEDIA_SESSION_CLOSE_AFTER_MS: recCtx("mediaSessionCloseAfterMs", String(10 * 60 * 1000)),
      // Monotonic media_sessions.time_source upgrade on segment ingest
      // (optimize-system-process-cycle Phase 1, Q6). Experiment flag, default
      // off; flip with `--context mediaTimeSourceUpgrade=1`.
      MEDIA_TIME_SOURCE_UPGRADE: recCtx("mediaTimeSourceUpgrade", "0"),
    };

    // onnxruntime-node (native, media targets only) is required lazily inside
    // the object-detection executor; it must be external in EVERY Lambda bundle
    // (the catalog registry pulls the node module in) and is never reached at
    // Lambda runtime (the Lambda engine refuses media graphs pre-flight).
    const commonBundling: nodejs.BundlingOptions = {
      minify: true,
      sourceMap: true,
      target: "node20",
      // @anthropic-ai/sdk mirrors onnxruntime-node: required lazily by the
      // model.vlm executor (engine/anthropic.ts), which only ever runs on the
      // media (Fargate) target; keeping it external keeps every Lambda bundle
      // free of it.
      externalModules: ["@aws-sdk/*", "onnxruntime-node", "@anthropic-ai/sdk", "mqtt"],
      forceDockerBundling: false,
    };

    // @aws-sdk/client-ecs and client-sqs are not guaranteed to be in the Lambda
    // runtime's bundled SDK (unlike client-s3 / client-rds-data), so any Lambda
    // that launches/stops Fargate tasks or enqueues workflow runs bundles the
    // SDK rather than externalize it.
    const bundlingWithSdk: nodejs.BundlingOptions = {
      ...commonBundling,
      externalModules: ["onnxruntime-node", "@anthropic-ai/sdk", "mqtt"],
    };

    const vpcProps: Pick<
      nodejs.NodejsFunctionProps,
      "vpc" | "vpcSubnets" | "securityGroups"
    > =
      vpc && lambdaSG
        ? {
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroups: [lambdaSG],
          }
        : {};

    const entryBase = path.join(__dirname, "../../src/handlers");

    const standardFnProps = (
      entry: string,
      description: string,
      withDb = true,
    ): nodejs.NodejsFunctionProps => ({
      entry,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      role: lambdaRole,
      // health Lambda doesn't touch the DB; skip VPC props to avoid the cold-start penalty.
      ...(withDb ? vpcProps : {}),
      environment: commonEnv,
      bundling: commonBundling,
      description,
    });

    const healthFn = new nodejs.NodejsFunction(
      this,
      "HealthFn",
      standardFnProps(path.join(entryBase, "health.ts"), "GET /health", false),
    );

    const meFn = new nodejs.NodejsFunction(
      this,
      "MeFn",
      standardFnProps(
        path.join(entryBase, "me.ts"),
        "GET /me — current user + memberships",
      ),
    );

    const organizationsFn = new nodejs.NodejsFunction(
      this,
      "OrganizationsFn",
      standardFnProps(
        path.join(entryBase, "organizations.ts"),
        "CRUD /organizations",
      ),
    );

    const membershipsFn = new nodejs.NodejsFunction(this, "MembershipsFn", {
      ...standardFnProps(
        path.join(entryBase, "memberships.ts"),
        "CRUD /memberships",
      ),
      // Bundles @aws-sdk/client-cognito-identity-provider for the invite path
      // (AdminCreateUser), which isn't guaranteed in the Lambda runtime SDK.
      bundling: bundlingWithSdk,
    });

    const apiKeysFn = new nodejs.NodejsFunction(
      this,
      "ApiKeysFn",
      standardFnProps(path.join(entryBase, "api-keys.ts"), "CRUD /api-keys"),
    );

    const workspacesFn = new nodejs.NodejsFunction(
      this,
      "WorkspacesFn",
      standardFnProps(path.join(entryBase, "workspaces.ts"), "CRUD /workspaces"),
    );

    const deviceModelsFn = new nodejs.NodejsFunction(
      this,
      "DeviceModelsFn",
      standardFnProps(
        path.join(entryBase, "device-models.ts"),
        "CRUD /device-models (admin-write)",
      ),
    );

    const devicesFn = new nodejs.NodejsFunction(this, "DevicesFn", {
      ...standardFnProps(path.join(entryBase, "devices.ts"), "CRUD /devices"),
      // Bundles @aws-sdk/client-iot-data-plane (retained device-config publish),
      // which isn't guaranteed in the Lambda runtime SDK.
      bundling: bundlingWithSdk,
    });

    const deviceCommandsFn = new nodejs.NodejsFunction(this, "DeviceCommandsFn", {
      ...standardFnProps(
        path.join(entryBase, "device-commands.ts"),
        "POST /devices/{id}/reboot|power-off — one-shot device commands",
      ),
      // Bundles @aws-sdk/client-iot-data-plane (command publish), which isn't
      // guaranteed in the Lambda runtime SDK.
      bundling: bundlingWithSdk,
    });

    const searchFn = new nodejs.NodejsFunction(
      this,
      "SearchFn",
      standardFnProps(
        path.join(entryBase, "search.ts"),
        "GET /search — global cross-resource search",
      ),
    );

    const deviceProvisioningFn = new nodejs.NodejsFunction(this, "DeviceProvisioningFn", {
      ...standardFnProps(
        path.join(entryBase, "device-provisioning.ts"),
        "POST /devices/{id}/provision — IoT cert + KVS channels",
      ),
      // Provisioning makes several IoT/KVS round-trips; give it more headroom than the 10s default.
      timeout: cdk.Duration.seconds(30),
    });

    // Device registration (onboarding): mint/poll a code, and the unauthenticated
    // claim that creates the device row + provisions IoT/KVS (same round-trips as
    // DeviceProvisioningFn → 30s timeout). API_BASE_URL injected below.
    const deviceRegistrationsFn = new nodejs.NodejsFunction(this, "DeviceRegistrationsFn", {
      ...standardFnProps(
        path.join(entryBase, "device-registrations.ts"),
        "device registrations — create/poll/claim",
      ),
      timeout: cdk.Duration.seconds(30),
    });

    // GET /get/{code} — serves the per-request install.sh as text/x-shellscript.
    // No DB writes; bakes the dist bucket URL + version into the script.
    const installScriptFn = new nodejs.NodejsFunction(this, "InstallScriptFn", {
      ...standardFnProps(
        path.join(entryBase, "install-script.ts"),
        "GET /get/{code} — render install.sh",
      ),
    });
    installScriptFn.addEnvironment(
      "DEVICE_DIST_BUCKET_URL",
      `https://${distBucket.bucketRegionalDomainName}`,
    );
    installScriptFn.addEnvironment("DEVICE_DIST_VERSION", "latest");

    // GET /devices/{id}/kvs-channels (P3) — returns the device's KVS signaling
    // channels so the browser can run a WebRTC VIEWER. Reads Postgres only (no KVS
    // call, no new IAM); the browser mints its own scoped creds via Cognito.
    const deviceKvsChannelsFn = new nodejs.NodejsFunction(
      this,
      "DeviceKvsChannelsFn",
      standardFnProps(
        path.join(entryBase, "device-kvs-channels.ts"),
        "GET /devices/{id}/kvs-channels — KVS channels for the browser viewer",
      ),
    );

    // GET /devices/{id}/identity (P3) — the device's IoT X.509 identity metadata
    // (thing name, cert id, status, policy/role binding). Non-secret fields only;
    // reads Postgres (no IoT call, no new IAM).
    const deviceIdentityFn = new nodejs.NodejsFunction(
      this,
      "DeviceIdentityFn",
      standardFnProps(
        path.join(entryBase, "device-identity.ts"),
        "GET /devices/{id}/identity — IoT identity metadata",
      ),
    );

    // (DeviceRecordingsFn + the /devices/{id}/recordings* routes REMOVED in
    // destroy-kvs-recorder Phase 5, together with src/handlers/device-recordings.ts.)

    // /devices/{id}/sessions (+ segment sub-routes) — index over
    // device-recorded media sessions/segments (offline recording plan, Phase 4;
    // session DELETE added Phase 6.3 — S3 object deletion is covered by the
    // shared lambdaRole's bucket.grantReadWrite above, which includes
    // s3:DeleteObject*). Presigns S3 GETs for per-segment playback (same
    // posture as recordings). Also serves /devices/{id}/replay-manifest
    // (Composite Replays plan, Phase 2) — batch-presigns up to 600 segment
    // URLs per request, still local crypto (no S3 calls, no new IAM).
    const deviceSessionsFn = new nodejs.NodejsFunction(this, "DeviceSessionsFn", {
      ...standardFnProps(
        path.join(entryBase, "device-sessions.ts"),
        "GET/DELETE /devices/{id}/sessions(+/segments,/playback,/replay-manifest) — device-recorded media index",
      ),
      timeout: cdk.Duration.seconds(15),
      bundling: bundlingWithSdk,
    });

    // (MediaFinalizeFn + MediaFinalizeRule on media/v1/* REMOVED in
    // destroy-kvs-recorder Phase 5, together with src/handlers/media-finalize.ts.
    // The bucket keeps EventBridge notifications enabled — MediaSegmentIngestRule
    // and the telemetry batch rule below depend on them.)

    // GET /devices/{id}/telemetry + /telemetry/latest + /telemetry/recent +
    // /telemetry/readings (P4) — historical telemetry reads over the partitioned
    // telemetry_readings + device_latest tables. Reads Postgres only (no new IAM).
    const telemetryHistoryFn = new nodejs.NodejsFunction(this, "TelemetryHistoryFn", {
      ...standardFnProps(
        path.join(entryBase, "telemetry-history.ts"),
        "GET /devices/{id}/telemetry(+/latest,/recent,/readings) — historical telemetry reads",
      ),
      // Range queries scan monthly partitions; give them more headroom than the default.
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
    });

    // SNS topic for operational alarms (kvs-webrtc-lts §13 T3). Alarms that fire on a
    // real ingestion failure (DLQ depth) publish here. Add an email subscriber with
    // `--context alarmEmail=you@example.com`; otherwise the topic still records the
    // alarm state transition for dashboards / future subscribers.
    const alarmTopic = new sns.Topic(this, "OpsAlarmTopic", {
      displayName: isProd ? "xorgate ops alarms" : "xorgate ops alarms (dev)",
    });
    const alarmEmail = this.node.tryGetContext("alarmEmail");
    if (typeof alarmEmail === "string" && alarmEmail.length > 0) {
      alarmTopic.addSubscription(new snsSubs.EmailSubscription(alarmEmail));
    }

    // Function-level async on-failure DLQ for TelemetryIngestFn (kvs-webrtc-lts §13
    // T3). Distinct from the IoT RULE DLQ below: the rule DLQ only catches action-
    // INVOCATION failures (rule can't reach the Lambda), NOT a Lambda that runs and
    // throws (DB down, partition miss). Without this, a throwing async invoke retries
    // twice then is DROPPED silently. This captures it.
    const telemetryFnDlq = new sqs.Queue(this, "TelemetryIngestFnDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });

    // --- Live telemetry ingestion (P2): IoT Topic Rule -> Lambda -> Postgres ---
    // The ingestion Lambda has NO HTTP route; it is invoked directly by the IoT
    // rule below. The rule MUST be created in this (api) stack — iot-stack is
    // synthesized first and cannot reference this Lambda.
    const telemetryIngestFn = new nodejs.NodejsFunction(this, "TelemetryIngestFn", {
      ...standardFnProps(
        path.join(entryBase, "telemetry-ingest.ts"),
        "IoT rule -> telemetry_readings + device_latest + last_seen",
      ),
      // One message = up to 3 Data API round-trips (insert + upsert + heartbeat).
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      // Bundles client-sqs: telemetry triggers enqueue workflow runs.
      bundling: bundlingWithSdk,
      // Capture async-invoke failures that survive Lambda's own retries (T3).
      onFailure: new lambdaDestinations.SqsDestination(telemetryFnDlq),
    });

    // EventBridge ~1 min -> housekeeping tick: flip stale `online` devices to
    // `offline`, close stale device-recorded media sessions, and expire segment
    // index rows. Bundles client-sqs (session_completed triggers enqueue runs).
    // Reuses THIS existing tick — no new schedule -> no new Aurora wake source
    // (kvs-webrtc-lts §7.3).
    const offlineSweeperFn = new nodejs.NodejsFunction(this, "OfflineSweeperFn", {
      ...standardFnProps(
        path.join(entryBase, "offline-sweeper.ts"),
        "Schedule (1m) -> offline sweep + media-session close + segment expiry",
      ),
      timeout: cdk.Duration.seconds(30),
      bundling: bundlingWithSdk,
    });
    new events.Rule(this, "OfflineSweeperSchedule", {
      description: "Housekeeping: offline sweep + media-session close (P2 telemetry / offline recording)",
      enabled: !props.disableScheduledJobs,
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(offlineSweeperFn)],
    });

    // EventBridge monthly -> pre-create upcoming telemetry_readings partitions
    // (a missing month partition breaks ingestion). Mid-month cron: the +1/+2
    // partitions from the previous run still cover us if one run fails.
    const partitionMaintenanceFn = new nodejs.NodejsFunction(
      this,
      "PartitionMaintenanceFn",
      standardFnProps(
        path.join(entryBase, "partition-maintenance.ts"),
        "Schedule (monthly) -> ensure telemetry_readings month partitions",
      ),
    );
    new events.Rule(this, "PartitionMaintenanceSchedule", {
      description: "Pre-create monthly telemetry_readings partitions (P4)",
      enabled: !props.disableScheduledJobs,
      schedule: events.Schedule.cron({ minute: "0", hour: "2", day: "15" }),
      targets: [new targets.LambdaFunction(partitionMaintenanceFn)],
    });

    // Dead-letter queue for messages the rule could not act on (action failure).
    const telemetryDlq = new sqs.Queue(this, "TelemetryIngestDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    // The IoT rule assumes this role to write to the DLQ on action error.
    const telemetryRuleRole = new iam.Role(this, "TelemetryRuleRole", {
      assumedBy: new iam.ServicePrincipal("iot.amazonaws.com"),
      description: "Lets the telemetry IoT rule send failed messages to the DLQ",
    });
    telemetryDlq.grantSendMessages(telemetryRuleRole);

    // A message in the RULE DLQ means the IoT rule couldn't invoke the Lambda
    // (action-level failure). Now wired to the ops SNS topic (kvs-webrtc-lts §13 T3).
    const telemetryRuleDlqAlarm = new cloudwatch.Alarm(this, "TelemetryDlqDepthAlarm", {
      metric: telemetryDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Telemetry ingest IoT rule wrote failed messages to the DLQ",
    });
    telemetryRuleDlqAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // A message in the FUNCTION DLQ means the Lambda ran and threw past its retries
    // (DB down, partition miss) — the common failure the rule DLQ does NOT catch.
    // This is the one that actually protects telemetry persistence (T3).
    const telemetryFnDlqAlarm = new cloudwatch.Alarm(this, "TelemetryFnDlqDepthAlarm", {
      metric: telemetryFnDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "TelemetryIngestFn async invoke failed past retries (DB / partition miss)",
    });
    telemetryFnDlqAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    const telemetryRule = new iot.CfnTopicRule(this, "TelemetryIngestRule", {
      // IoT rule names allow only [A-Za-z0-9_] — underscores, not the kebab convention.
      ruleName: isProd ? "xorgate_telemetry_ingest" : "xorgate_telemetry_ingest_dev",
      topicRulePayload: {
        sql: "SELECT *, topic(3) AS topicDeviceId FROM 'xorgate/devices/+/telemetry'",
        awsIotSqlVersion: "2016-03-23",
        ruleDisabled: false,
        actions: [{ lambda: { functionArn: telemetryIngestFn.functionArn } }],
        errorAction: {
          sqs: {
            queueUrl: telemetryDlq.queueUrl,
            roleArn: telemetryRuleRole.roleArn,
            useBase64: false,
          },
        },
      },
    });

    // Resource-based invoke permission keyed on the rule ARN. This keeps a clean
    // fn -> rule -> permission DAG (no cycle); do NOT instead give the rule an IAM
    // role with lambda:InvokeFunction. sourceAccount guards the confused-deputy.
    telemetryIngestFn.addPermission("AllowIotRuleInvoke", {
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      sourceArn: telemetryRule.attrArn,
      sourceAccount: this.account,
      action: "lambda:InvokeFunction",
    });

    // --- Batch telemetry ingest (offline recording plan, Phase 2) ---
    // Device uploads a closed recording segment to telemetry/v1/... (direct S3
    // PUT with IoT role-alias creds) -> S3 Object Created -> EventBridge ->
    // this Lambda -> telemetry_readings (history only; never device_latest, D4).
    // Function-level DLQ catches a Lambda that ran and threw past its retries
    // (DB down / partition miss); the rule target DLQ catches invocation
    // failures — same two-layer posture as the live telemetry path above.
    const telemetryBatchFnDlq = new sqs.Queue(this, "TelemetryBatchIngestFnDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    const telemetryBatchIngestFn = new nodejs.NodejsFunction(this, "TelemetryBatchIngestFn", {
      ...standardFnProps(
        path.join(entryBase, "telemetry-batch-ingest.ts"),
        "S3 Object Created(telemetry/v1/*.jsonl.gz) -> batch insert telemetry_readings",
      ),
      // A 60 s segment at 10 Hz is ~600 samples (~12k rows) -> dozens of
      // sequential Data API batches inside one transaction; give it headroom.
      memorySize: 512,
      timeout: cdk.Duration.minutes(2),
      environment: {
        ...commonEnv,
        // Partition-age acceptance window (services/telemetry-batch.ts).
        TELEMETRY_BATCH_MAX_AGE_DAYS: recCtx("telemetryBatchMaxAgeDays", "90"),
      },
      onFailure: new lambdaDestinations.SqsDestination(telemetryBatchFnDlq),
    });
    const telemetryBatchRuleDlq = new sqs.Queue(this, "TelemetryBatchIngestRuleDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    new events.Rule(this, "TelemetryBatchIngestRule", {
      description: "Device telemetry segment uploaded -> batch ingest into telemetry_readings",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: { name: [bucket.bucketName] },
          object: { key: [{ prefix: "telemetry/v1/" }] },
        },
      },
      targets: [
        new targets.LambdaFunction(telemetryBatchIngestFn, {
          deadLetterQueue: telemetryBatchRuleDlq,
          retryAttempts: 2,
        }),
      ],
    });
    const telemetryBatchDlqAlarm = new cloudwatch.Alarm(this, "TelemetryBatchDlqDepthAlarm", {
      metric: telemetryBatchFnDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "TelemetryBatchIngestFn async invoke failed past retries (segment not ingested)",
    });
    telemetryBatchDlqAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // --- Device video-segment ingest (offline recording plan, Phase 4) ---
    // Device uploads a video fragment pair (sidecar-first, then mp4) to
    // media-sessions/v1/... -> S3 Object Created -> EventBridge -> this Lambda
    // -> media_sessions/media_segments. The prefix is deliberately NOT
    // media/v1/, so MediaFinalizeRule never sees segment objects. Same
    // two-layer DLQ posture as the telemetry batch path above.
    const mediaSegmentFnDlq = new sqs.Queue(this, "MediaSegmentIngestFnDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    const mediaSegmentIngestFn = new nodejs.NodejsFunction(this, "MediaSegmentIngestFn", {
      ...standardFnProps(
        path.join(entryBase, "media-segment-ingest.ts"),
        "S3 Object Created(media-sessions/v1/*.mp4) -> media_sessions + media_segments",
      ),
      // Sidecar GET + a 3-statement transaction; the default 10 s is tight
      // against a cold Aurora resume.
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      onFailure: new lambdaDestinations.SqsDestination(mediaSegmentFnDlq),
    });
    const mediaSegmentRuleDlq = new sqs.Queue(this, "MediaSegmentIngestRuleDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    new events.Rule(this, "MediaSegmentIngestRule", {
      description: "Device video segment uploaded -> index into media_sessions/media_segments",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: { name: [bucket.bucketName] },
          object: { key: [{ prefix: "media-sessions/v1/" }] },
        },
      },
      targets: [
        new targets.LambdaFunction(mediaSegmentIngestFn, {
          deadLetterQueue: mediaSegmentRuleDlq,
          retryAttempts: 2,
        }),
      ],
    });
    const mediaSegmentDlqAlarm = new cloudwatch.Alarm(this, "MediaSegmentDlqDepthAlarm", {
      metric: mediaSegmentFnDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "MediaSegmentIngestFn async invoke failed past retries (video segment not indexed)",
    });
    mediaSegmentDlqAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // (RecordingCaptureFn + RecordingCaptureRule on xorgate/recordings/+/status
    // and its IoT invoke permission REMOVED in destroy-kvs-recorder Phase 5,
    // together with src/handlers/recording-capture.ts.)

    // --- Device status / Last-Will (kvs-webrtc-lts Phase 1): IoT Topic Rule -> Lambda ---
    // The device agent publishes {online} to xorgate/devices/<id>/status on connect,
    // on graceful shutdown, and via MQTT Last-Will on ungraceful disconnect (power-
    // off). This flips the device badge immediately. DB-only: it needs no AWS SDK
    // client beyond client-rds-data, so it uses the default bundling (the
    // corroborated recorder offline-stop that once required client-ecs went in
    // destroy-kvs-recorder Phase 3).
    const deviceStatusFn = new nodejs.NodejsFunction(this, "DeviceStatusFn", {
      ...standardFnProps(
        path.join(entryBase, "device-status.ts"),
        "IoT rule -> device status (LWT)",
      ),
      timeout: cdk.Duration.seconds(20),
    });

    const deviceStatusRule = new iot.CfnTopicRule(this, "DeviceStatusRule", {
      ruleName: isProd ? "xorgate_device_status" : "xorgate_device_status_dev",
      topicRulePayload: {
        sql: "SELECT *, topic(3) AS topicDeviceId FROM 'xorgate/devices/+/status'",
        awsIotSqlVersion: "2016-03-23",
        ruleDisabled: false,
        actions: [{ lambda: { functionArn: deviceStatusFn.functionArn } }],
        // Reuse the low-volume telemetry DLQ + role (one error sink, one alarm).
        errorAction: {
          sqs: {
            queueUrl: telemetryDlq.queueUrl,
            roleArn: telemetryRuleRole.roleArn,
            useBase64: false,
          },
        },
      },
    });

    deviceStatusFn.addPermission("AllowIotRuleInvoke", {
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      sourceArn: deviceStatusRule.attrArn,
      sourceAccount: this.account,
      action: "lambda:InvokeFunction",
    });

    const iotAttachPolicyFn = new nodejs.NodejsFunction(
      this,
      "IotAttachPolicyFn",
      standardFnProps(
        path.join(entryBase, "iot-attach-policy.ts"),
        "POST /iot/attach-policy — attach browser IoT policy to caller's Cognito identity",
      ),
    );

    // --- Workflows (user-defined processing pipelines) ---
    // Org-scoped template CRUD + versioning. Reads/writes Postgres only (no new
    // IAM). The run-execution Lambdas (dispatch/finalize/scheduler) land with M3–M5.
    const workflowTemplatesFn = new nodejs.NodejsFunction(
      this,
      "WorkflowTemplatesFn",
      standardFnProps(
        path.join(entryBase, "workflow-templates.ts"),
        "CRUD + versioning /workflow-templates",
      ),
    );

    // Served node catalog (M1): the declarative NodeTypeDef registry as JSON
    // Schema. Static per deployment; needs auth (org membership) hence DB/VPC.
    const workflowCatalogFn = new nodejs.NodejsFunction(
      this,
      "WorkflowCatalogFn",
      standardFnProps(
        path.join(entryBase, "workflow-catalog.ts"),
        "GET /workflow-catalog — served node type catalog",
      ),
    );

    // Model registry (M2): lists models/<family>/<name>/<version>/manifest.json
    // from the core bucket for the model pickers. S3 read comes from the shared
    // lambdaRole bucket grant.
    const modelRegistryFn = new nodejs.NodejsFunction(
      this,
      "ModelRegistryFn",
      standardFnProps(
        path.join(entryBase, "model-registry.ts"),
        "GET /model-registry — S3 model registry listing",
      ),
    );

    // Device attachments (attach/list/enable/detach + Run now). Run now fires a
    // run via fireWorkflowRun -> SQS, so it bundles the AWS SDK (client-sqs).
    const deviceWorkflowsFn = new nodejs.NodejsFunction(this, "DeviceWorkflowsFn", {
      ...standardFnProps(
        path.join(entryBase, "device-workflows.ts"),
        "attach/list/enable/detach/run /devices/{id}/workflows",
      ),
      bundling: bundlingWithSdk,
    });

    // Workflow runs read API (workspace list + detail + per-device list) + rerun
    // (fires via SQS -> bundles client-sqs).
    const workflowRunsFn = new nodejs.NodejsFunction(this, "WorkflowRunsFn", {
      ...standardFnProps(
        path.join(entryBase, "workflow-runs.ts"),
        "GET /workflow-runs(+/{id}), /devices/{id}/workflow-runs, POST rerun",
      ),
      bundling: bundlingWithSdk,
    });

    // SQS run queue + DLQ. Triggers pre-create a run and enqueue {runId}; the
    // dispatcher runs telemetry graphs inline and launches Fargate for video.
    const workflowRunDlq = new sqs.Queue(this, "WorkflowRunDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    const workflowRunQueue = new sqs.Queue(this, "WorkflowRunQueue", {
      // ~6x the dispatcher timeout (120s) so a slow inline run isn't redelivered.
      visibilityTimeout: cdk.Duration.seconds(720),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: workflowRunDlq, maxReceiveCount: 3 },
    });
    // The shared Lambda role can enqueue runs (telemetry/media/http firing paths).
    workflowRunQueue.grantSendMessages(lambdaRole);

    // Run dispatcher: SQS-driven; since the M6 cutover every triggered run is
    // claimed (dispatched_at) and dispatched to the v2 engine (Lambda for
    // telemetry-only graphs, engine-runner RunTask for media). Bundles the AWS
    // SDK (client-sqs / client-ecs / client-lambda).
    const workflowDispatchFn = new nodejs.NodejsFunction(this, "WorkflowDispatchFn", {
      ...standardFnProps(
        path.join(entryBase, "workflow-dispatch.ts"),
        "SQS -> claim + dispatch workflow run (v2 engine: Lambda / Fargate)",
      ),
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      bundling: bundlingWithSdk,
    });
    workflowDispatchFn.addEventSource(
      new lambdaEventSources.SqsEventSource(workflowRunQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // All firing paths + the dispatcher need the queue URL.
    workflowDispatchFn.addEnvironment("WORKFLOW_QUEUE_URL", workflowRunQueue.queueUrl);
    deviceWorkflowsFn.addEnvironment("WORKFLOW_QUEUE_URL", workflowRunQueue.queueUrl);
    workflowRunsFn.addEnvironment("WORKFLOW_QUEUE_URL", workflowRunQueue.queueUrl);
    telemetryIngestFn.addEnvironment("WORKFLOW_QUEUE_URL", workflowRunQueue.queueUrl);
    // Phase 6.4: session_completed fires from the sweeper's close pass AND the
    // sessions list's close-on-read — both evaluate triggers via
    // fireWorkflowRun, which enqueues here. (Caught live: without these the
    // run row is created and then flipped to failed with "enqueue failed".)
    offlineSweeperFn.addEnvironment("WORKFLOW_QUEUE_URL", workflowRunQueue.queueUrl);
    deviceSessionsFn.addEnvironment("WORKFLOW_QUEUE_URL", workflowRunQueue.queueUrl);
    // destroy-kvs-recorder Phase W: segment_uploaded fires from the segment
    // ingest path, so it enqueues here too. (Caught live the same way as the
    // Phase 6.4 pair above — the run row is created and immediately flipped to
    // failed with "enqueue failed: WORKFLOW_QUEUE_URL is not configured".)
    mediaSegmentIngestFn.addEnvironment("WORKFLOW_QUEUE_URL", workflowRunQueue.queueUrl);

    // v2 engine runner launch config (media graphs; Lambda engine handles
    // telemetry-only). Same cluster/VPC/SG as the recorder. The CV_* env and
    // the WORKFLOW_V2_EXPERIMENT flag were retired with the M6 cutover.
    workflowDispatchFn.addEnvironment("ENGINE_CLUSTER_ARN", recorderClusterArn);
    workflowDispatchFn.addEnvironment("ENGINE_TASKDEF", engineTaskFamily);
    workflowDispatchFn.addEnvironment("ENGINE_SUBNETS", recorderSubnets);
    workflowDispatchFn.addEnvironment("ENGINE_SG", recorderSecurityGroupId);
    workflowDispatchFn.addEnvironment("ENGINE_CONTAINER_NAME", engineContainerName);

    // Fargate CV-run finalizer: result.json (S3 Object Created under workflows/v1/)
    // -> persist steps/events + run status. Same EventBridge->finalize pattern as
    // media-finalize (the bucket already emits EventBridge notifications).
    const workflowRunFinalizeFn = new nodejs.NodejsFunction(this, "WorkflowRunFinalizeFn", {
      ...standardFnProps(
        path.join(entryBase, "workflow-run-finalize.ts"),
        "S3 result.json(workflows/v1/*) -> finalize workflow run",
      ),
      timeout: cdk.Duration.seconds(30),
    });
    new events.Rule(this, "WorkflowRunFinalizeRule", {
      description: "CV runner result.json uploaded -> finalize workflow run",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: { name: [bucket.bucketName] },
          object: { key: [{ prefix: "workflows/v1/" }] },
        },
      },
      targets: [new targets.LambdaFunction(workflowRunFinalizeFn)],
    });
    // v2 TS-engine results (workflows/v2/) go to the same finalizer, which
    // branches on resultVersion and still acts only on keys ending in
    // /result.json (manifests, frames, and records are ignored).
    new events.Rule(this, "WorkflowRunFinalizeV2Rule", {
      description: "v2 engine result.json uploaded -> finalize workflow run",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: { name: [bucket.bucketName] },
          object: { key: [{ prefix: "workflows/v2/" }] },
        },
      },
      targets: [new targets.LambdaFunction(workflowRunFinalizeFn)],
    });

    // v2 TS engine, Lambda target (M2): direct-invoked with {runId}; reads the
    // workflows/v2/runs/<runId>/manifest.json run spec and writes events/records/
    // result.json back under the same prefix. The dispatcher does NOT route to it
    // yet (PoC inline runner + cv-runner stay until M6); the invoke grant and env
    // var are pre-wired so cutover is a dispatcher-code-only change. S3 access
    // comes from the shared lambdaRole's bucket grant; DB access is the telemetry
    // read seam only.
    //
    // The function name is explicit so the invoke grant and the dispatcher env
    // var can be literal strings: grantInvoke(lambdaRole) would put this
    // function's ARN into the shared role's default policy, and every function
    // on that role (this one included) DependsOn that policy — a CFN circular
    // dependency.
    const workflowEngineFnName = `xorgate-workflow-engine-${stage}`;
    new nodejs.NodejsFunction(this, "WorkflowEngineFn", {
      ...standardFnProps(
        path.join(entryBase, "workflow-engine.ts"),
        "v2 engine (Lambda target): workflows/v2 manifest -> run graph -> result.json",
      ),
      functionName: workflowEngineFnName,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      // M3: publishes simulator progress (client-iot-data-plane) and reads the
      // Roads key (client-secrets-manager); neither is guaranteed in the Lambda
      // runtime SDK, so bundle the SDK like the other IoT/ECS-calling Lambdas.
      bundling: bundlingWithSdk,
      environment: {
        ...commonEnv,
        GOOGLE_ROADS_SECRET_NAME: googleRoadsSecretName,
        HERE_SECRET_NAME: hereSecretName,
        ANTHROPIC_SECRET_NAME: anthropicSecretName,
      },
    });
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [
          this.formatArn({
            service: "lambda",
            resource: "function",
            resourceName: workflowEngineFnName,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    workflowDispatchFn.addEnvironment("WORKFLOW_ENGINE_FN", workflowEngineFnName);

    // Simulator API (M3): creates mode='simulation' runs from the editor's
    // draft, presigns input uploads, and dispatches the v2 engine DIRECTLY
    // (Lambda invoke / RunTask; no SQS hop — interactive callers want dispatch
    // errors synchronously). Bundles the SDK (client-ecs, client-lambda,
    // s3-presigned-post). The invoke grant and ECS Run/PassRole grants already
    // exist on the shared lambdaRole (literal ARNs).
    const workflowSimulationsFn = new nodejs.NodejsFunction(this, "WorkflowSimulationsFn", {
      ...standardFnProps(
        path.join(entryBase, "workflow-simulations.ts"),
        "POST /workflow-templates/{id}/simulations(+/uploads) — simulator runs",
      ),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      bundling: bundlingWithSdk,
    });
    workflowSimulationsFn.addEnvironment("WORKFLOW_ENGINE_FN", workflowEngineFnName);
    workflowSimulationsFn.addEnvironment("ENGINE_CLUSTER_ARN", recorderClusterArn);
    workflowSimulationsFn.addEnvironment("ENGINE_TASKDEF", engineTaskFamily);
    workflowSimulationsFn.addEnvironment("ENGINE_SUBNETS", recorderSubnets);
    workflowSimulationsFn.addEnvironment("ENGINE_SG", recorderSecurityGroupId);
    workflowSimulationsFn.addEnvironment("ENGINE_CONTAINER_NAME", engineContainerName);
    // Warm simulator sessions (M5): per-(org, template) SQS queues under this
    // prefix; unset would disable the warm path (cold RunTask per run).
    workflowSimulationsFn.addEnvironment("WF_SESSION_QUEUE_PREFIX", sessionQueuePrefix);

    // Per-org connector credentials (M7): set/rotate/clear/validate BYO API
    // keys (google_roads / here / anthropic) stored as
    // xorgate/orgs/<orgId>/<provider> secrets. Bundles the SDK
    // (client-secrets-manager); the validate probes call the providers
    // outbound, so give it probe headroom over the 10 s default.
    const organizationCredentialsFn = new nodejs.NodejsFunction(
      this,
      "OrganizationCredentialsFn",
      {
        ...standardFnProps(
          path.join(entryBase, "organization-credentials.ts"),
          "org connector credentials — set/rotate/clear/validate",
        ),
        timeout: cdk.Duration.seconds(20),
        memorySize: 256,
        bundling: bundlingWithSdk,
        environment: {
          ...commonEnv,
          // Platform defaults the validate endpoint can probe.
          GOOGLE_ROADS_SECRET_NAME: googleRoadsSecretName,
          HERE_SECRET_NAME: hereSecretName,
          ANTHROPIC_SECRET_NAME: anthropicSecretName,
        },
      },
    );

    // Workflow scheduler (1-min tick): schedule triggers + the stuck-run watchdog.
    // Fires runs (SQS) and StopTask's stale Fargate tasks -> bundles the AWS SDK.
    // Gated by disableScheduledJobs (OFF in dev by default, so the shared sandbox
    // Aurora can auto-pause); enable in dev with --context scheduledJobs=on.
    const workflowSchedulerFn = new nodejs.NodejsFunction(this, "WorkflowSchedulerFn", {
      ...standardFnProps(
        path.join(entryBase, "workflow-scheduler.ts"),
        "Schedule (1m) -> fire schedule triggers + watchdog stuck runs",
      ),
      timeout: cdk.Duration.seconds(60),
      bundling: bundlingWithSdk,
    });
    workflowSchedulerFn.addEnvironment("WORKFLOW_QUEUE_URL", workflowRunQueue.queueUrl);
    new events.Rule(this, "WorkflowSchedulerSchedule", {
      description: "Workflow schedule triggers + stuck-run watchdog",
      enabled: !props.disableScheduledJobs,
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(workflowSchedulerFn)],
    });

    const docsFn = new nodejs.NodejsFunction(this, "DocsFn", {
      entry: path.join(entryBase, "docs.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      role: lambdaRole,
      // No VPC props — docs Lambda doesn't touch DB or S3; avoids VPC cold-start penalty.
      // DOCS_BASE_URL is injected below once `this.api` exists.
      environment: { NODE_ENV: isProd ? "production" : "development" },
      bundling: commonBundling,
      description: "GET /docs (Swagger UI) + GET /openapi.json",
    });

    this.api = new apigwv2.HttpApi(this, "XorgateCoreApi", {
      apiName: isProd ? "xorgate-core-api" : "xorgate-core-api-dev",
      description: "Xorgate core backend HTTP API",
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: [
          "Authorization",
          "Content-Type",
          "X-Request-ID",
          "X-Organization-Id",
          "X-Workspace-Id",
        ],
        maxAge: cdk.Duration.hours(24),
      },
    });

    const healthInt = new apigwv2int.HttpLambdaIntegration(
      "HealthInt",
      healthFn,
    );
    const meInt = new apigwv2int.HttpLambdaIntegration("MeInt", meFn);
    const organizationsInt = new apigwv2int.HttpLambdaIntegration(
      "OrganizationsInt",
      organizationsFn,
    );
    const membershipsInt = new apigwv2int.HttpLambdaIntegration(
      "MembershipsInt",
      membershipsFn,
    );
    const apiKeysInt = new apigwv2int.HttpLambdaIntegration(
      "ApiKeysInt",
      apiKeysFn,
    );
    const workspacesInt = new apigwv2int.HttpLambdaIntegration(
      "WorkspacesInt",
      workspacesFn,
    );
    const deviceModelsInt = new apigwv2int.HttpLambdaIntegration(
      "DeviceModelsInt",
      deviceModelsFn,
    );
    const devicesInt = new apigwv2int.HttpLambdaIntegration(
      "DevicesInt",
      devicesFn,
    );
    const deviceCommandsInt = new apigwv2int.HttpLambdaIntegration(
      "DeviceCommandsInt",
      deviceCommandsFn,
    );
    const searchInt = new apigwv2int.HttpLambdaIntegration(
      "SearchInt",
      searchFn,
    );
    const deviceProvisioningInt = new apigwv2int.HttpLambdaIntegration(
      "DeviceProvisioningInt",
      deviceProvisioningFn,
    );
    const deviceRegistrationsInt = new apigwv2int.HttpLambdaIntegration(
      "DeviceRegistrationsInt",
      deviceRegistrationsFn,
    );
    const installScriptInt = new apigwv2int.HttpLambdaIntegration(
      "InstallScriptInt",
      installScriptFn,
    );
    const deviceKvsChannelsInt = new apigwv2int.HttpLambdaIntegration(
      "DeviceKvsChannelsInt",
      deviceKvsChannelsFn,
    );
    const deviceIdentityInt = new apigwv2int.HttpLambdaIntegration(
      "DeviceIdentityInt",
      deviceIdentityFn,
    );
    const telemetryHistoryInt = new apigwv2int.HttpLambdaIntegration(
      "TelemetryHistoryInt",
      telemetryHistoryFn,
    );
    const deviceSessionsInt = new apigwv2int.HttpLambdaIntegration(
      "DeviceSessionsInt",
      deviceSessionsFn,
    );
    const iotAttachPolicyInt = new apigwv2int.HttpLambdaIntegration(
      "IotAttachPolicyInt",
      iotAttachPolicyFn,
    );
    const workflowTemplatesInt = new apigwv2int.HttpLambdaIntegration(
      "WorkflowTemplatesInt",
      workflowTemplatesFn,
    );
    const workflowCatalogInt = new apigwv2int.HttpLambdaIntegration(
      "WorkflowCatalogInt",
      workflowCatalogFn,
    );
    const modelRegistryInt = new apigwv2int.HttpLambdaIntegration(
      "ModelRegistryInt",
      modelRegistryFn,
    );
    const deviceWorkflowsInt = new apigwv2int.HttpLambdaIntegration(
      "DeviceWorkflowsInt",
      deviceWorkflowsFn,
    );
    const workflowRunsInt = new apigwv2int.HttpLambdaIntegration(
      "WorkflowRunsInt",
      workflowRunsFn,
    );
    const workflowSimulationsInt = new apigwv2int.HttpLambdaIntegration(
      "WorkflowSimulationsInt",
      workflowSimulationsFn,
    );
    const organizationCredentialsInt = new apigwv2int.HttpLambdaIntegration(
      "OrganizationCredentialsInt",
      organizationCredentialsFn,
    );
    const docsInt = new apigwv2int.HttpLambdaIntegration("DocsInt", docsFn);

    // Inject the API endpoint into the docs Lambda now that the api exists.
    docsFn.addEnvironment("DOCS_BASE_URL", this.api.apiEndpoint);

    // Device-registration Lambdas need the public API base to build the install
    // URL and the claim URL baked into install.sh. Same chicken-and-egg as
    // DOCS_BASE_URL — inject it now that `this.api` exists. No DNS yet, so this
    // is the generated execute-api endpoint.
    deviceRegistrationsFn.addEnvironment("API_BASE_URL", this.api.apiEndpoint);
    installScriptFn.addEnvironment("API_BASE_URL", this.api.apiEndpoint);

    this.api.addRoutes({
      path: "/health",
      methods: [apigwv2.HttpMethod.GET],
      integration: healthInt,
    });

    this.api.addRoutes({
      path: "/me",
      methods: [apigwv2.HttpMethod.GET],
      integration: meInt,
    });

    this.api.addRoutes({
      path: "/organizations",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: organizationsInt,
    });
    this.api.addRoutes({
      path: "/organizations/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: organizationsInt,
    });

    this.api.addRoutes({
      path: "/memberships",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: membershipsInt,
    });
    this.api.addRoutes({
      path: "/memberships/{id}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: membershipsInt,
    });

    this.api.addRoutes({
      path: "/api-keys",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: apiKeysInt,
    });
    this.api.addRoutes({
      path: "/api-keys/{id}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: apiKeysInt,
    });

    this.api.addRoutes({
      path: "/workspaces",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: workspacesInt,
    });
    this.api.addRoutes({
      path: "/workspaces/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: workspacesInt,
    });

    this.api.addRoutes({
      path: "/device-models",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: deviceModelsInt,
    });
    this.api.addRoutes({
      path: "/device-models/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: deviceModelsInt,
    });

    this.api.addRoutes({
      path: "/search",
      methods: [apigwv2.HttpMethod.GET],
      integration: searchInt,
    });

    this.api.addRoutes({
      path: "/devices",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: devicesInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: devicesInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/provision",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceProvisioningInt,
    });
    // One-shot commands. Separate routes rather than one /commands endpoint so
    // each action is independently visible in the route table and in docs.
    this.api.addRoutes({
      path: "/devices/{id}/reboot",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceCommandsInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/power-off",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceCommandsInt,
    });

    // Device registration (onboarding). The {code}/claim route is reached
    // unauthenticated by install.sh — the handler skips auth for it.
    this.api.addRoutes({
      path: "/device-registrations",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceRegistrationsInt,
    });
    this.api.addRoutes({
      path: "/device-registrations/{code}",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceRegistrationsInt,
    });
    this.api.addRoutes({
      path: "/device-registrations/{code}/claim",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceRegistrationsInt,
    });
    this.api.addRoutes({
      path: "/get/{code}",
      methods: [apigwv2.HttpMethod.GET],
      integration: installScriptInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/kvs-channels",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceKvsChannelsInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/identity",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceIdentityInt,
    });
    // Device-recorded media sessions (offline recording plan, Phase 4;
    // DELETE added in Phase 6.3).
    this.api.addRoutes({
      path: "/devices/{id}/sessions",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceSessionsInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/sessions/{sessionId}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: deviceSessionsInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/sessions/{sessionId}/segments",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceSessionsInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/sessions/{sessionId}/segments/{seq}/playback",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceSessionsInt,
    });
    // Replay manifest (Composite Replays plan, Phase 2): gap-aware timeline +
    // batch-presigned segment URLs, one response per replay (R3).
    this.api.addRoutes({
      path: "/devices/{id}/replay-manifest",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceSessionsInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/telemetry",
      methods: [apigwv2.HttpMethod.GET],
      integration: telemetryHistoryInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/telemetry/latest",
      methods: [apigwv2.HttpMethod.GET],
      integration: telemetryHistoryInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/telemetry/recent",
      methods: [apigwv2.HttpMethod.GET],
      integration: telemetryHistoryInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/telemetry/readings",
      methods: [apigwv2.HttpMethod.GET],
      integration: telemetryHistoryInt,
    });

    this.api.addRoutes({
      path: "/iot/attach-policy",
      methods: [apigwv2.HttpMethod.POST],
      integration: iotAttachPolicyInt,
    });

    // Workflow templates (org-scoped) + versioning.
    this.api.addRoutes({
      path: "/workflow-templates",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: workflowTemplatesInt,
    });
    this.api.addRoutes({
      path: "/workflow-templates/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: workflowTemplatesInt,
    });
    this.api.addRoutes({
      path: "/workflow-templates/{id}/draft",
      methods: [apigwv2.HttpMethod.PUT],
      integration: workflowTemplatesInt,
    });
    this.api.addRoutes({
      path: "/workflow-templates/{id}/versions/{versionId}/publish",
      methods: [apigwv2.HttpMethod.POST],
      integration: workflowTemplatesInt,
    });
    this.api.addRoutes({
      path: "/workflow-templates/{id}/versions/{versionId}/restore",
      methods: [apigwv2.HttpMethod.POST],
      integration: workflowTemplatesInt,
    });
    this.api.addRoutes({
      path: "/workflow-templates/{id}/usage",
      methods: [apigwv2.HttpMethod.GET],
      integration: workflowTemplatesInt,
    });

    // Simulator (M3): create a simulation run / presign an input upload.
    this.api.addRoutes({
      path: "/workflow-templates/{id}/simulations",
      methods: [apigwv2.HttpMethod.POST],
      integration: workflowSimulationsInt,
    });
    this.api.addRoutes({
      path: "/workflow-templates/{id}/simulations/uploads",
      methods: [apigwv2.HttpMethod.POST],
      integration: workflowSimulationsInt,
    });

    // Per-org connector credentials (M7).
    this.api.addRoutes({
      path: "/organization-credentials",
      methods: [apigwv2.HttpMethod.GET],
      integration: organizationCredentialsInt,
    });
    this.api.addRoutes({
      path: "/organization-credentials/{provider}",
      methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration: organizationCredentialsInt,
    });
    this.api.addRoutes({
      path: "/organization-credentials/{provider}/validate",
      methods: [apigwv2.HttpMethod.POST],
      integration: organizationCredentialsInt,
    });

    // Served node catalog (static per deployment, ETag cached).
    this.api.addRoutes({
      path: "/workflow-catalog",
      methods: [apigwv2.HttpMethod.GET],
      integration: workflowCatalogInt,
    });

    // Model registry (model pickers in node config forms).
    this.api.addRoutes({
      path: "/model-registry",
      methods: [apigwv2.HttpMethod.GET],
      integration: modelRegistryInt,
    });

    // Device workflow attachments.
    this.api.addRoutes({
      path: "/devices/{id}/workflows",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: deviceWorkflowsInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/workflows/{attachmentId}",
      methods: [apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      integration: deviceWorkflowsInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/workflows/{attachmentId}/run",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceWorkflowsInt,
    });

    // Workflow runs (read + rerun).
    this.api.addRoutes({
      path: "/workflow-runs",
      methods: [apigwv2.HttpMethod.GET],
      integration: workflowRunsInt,
    });
    this.api.addRoutes({
      path: "/workflow-runs/{id}",
      methods: [apigwv2.HttpMethod.GET],
      integration: workflowRunsInt,
    });
    this.api.addRoutes({
      path: "/workflow-runs/{id}/rerun",
      methods: [apigwv2.HttpMethod.POST],
      integration: workflowRunsInt,
    });
    // Presigned GET for v2 run artifacts (Data Capture downloads etc., M3).
    this.api.addRoutes({
      path: "/workflow-runs/{id}/artifact-url",
      methods: [apigwv2.HttpMethod.GET],
      integration: workflowRunsInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/workflow-runs",
      methods: [apigwv2.HttpMethod.GET],
      integration: workflowRunsInt,
    });

    this.api.addRoutes({
      path: "/docs",
      methods: [apigwv2.HttpMethod.GET],
      integration: docsInt,
    });
    this.api.addRoutes({
      path: "/openapi.json",
      methods: [apigwv2.HttpMethod.GET],
      integration: docsInt,
    });

    new cdk.CfnOutput(this, "ApiUrl", {
      value: this.api.apiEndpoint,
      exportName: `XorgateCoreApiEndpoint${exportSuffix}`,
      description: "API Gateway HTTP API endpoint URL",
    });

    new cdk.CfnOutput(this, "ApiId", {
      value: this.api.apiId,
      exportName: `XorgateCoreApiId${exportSuffix}`,
    });

    new cdk.CfnOutput(this, "DocsUrl", {
      value: `${this.api.apiEndpoint}/docs`,
      description: "Swagger UI URL",
    });
  }
}
