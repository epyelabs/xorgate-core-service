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
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import * as lambdaDestinations from "aws-cdk-lib/aws-lambda-destinations";
import * as iot from "aws-cdk-lib/aws-iot";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";

/**
 * The public hostname each stage answers on, and the ACM certificate in front
 * of it. Both are the USER'S to create (Q1 precedent in the docs plan): DNS for
 * xorgate.io is on Cloudflare, not Route 53, so nothing here can request or
 * validate a certificate, and the deploy credentials are denied ACM and
 * Route 53 entirely. The flow is: user issues the certificate, hands over the
 * ARN, this deploys the domain, and the user points a CNAME at the
 * `ApiDomainTarget` output.
 *
 * Set an entry to `undefined` to deploy without a custom domain; the API is
 * still reachable on its `execute-api` hostname either way, and `/v1` lives in
 * the route table rather than in a domain mapping, so the version prefix does
 * not depend on DNS existing.
 *
 * PROD IS LIVE since 2026-08-21, in its own AWS account (865609249890, part of
 * the org/account split): `api.xorgate.io` answers from there, and
 * `npm run deploy:prod` targets that account (the per-stage account pin in
 * bin/app.ts refuses credentials for any other). Deploying prod therefore
 * needs credentials that can assume into 865609249890, e.g.
 * `AWS_PROFILE=xorgate-prod`; the default dev-account profile only covers dev.
 */
const CUSTOM_DOMAINS: Record<
  "dev" | "prod",
  { hostname: string; certificateArn: string } | undefined
> = {
  dev: {
    hostname: "api-dev.xorgate.io",
    certificateArn:
      "arn:aws:acm:us-east-1:111910761410:certificate/9891cf72-d40d-4565-bc5e-9419684748e1",
  },
  // Prod lives in its own account (865609249890) as of 2026-08-21. ACM
  // certificates cannot be moved between accounts, so this is a NEW certificate
  // rather than the migrated one, and unlike its predecessor it covers
  // api.xorgate.io ALONE. The old one was a multi-domain certificate whose CN
  // was dev.xorgate.io, which meant one certificate spanned both stages; it
  // stays in 111910761410 for the dev hostnames that still use it.
  prod: {
    hostname: "api.xorgate.io",
    certificateArn:
      "arn:aws:acm:us-east-1:865609249890:certificate/6b724695-f3fe-4599-8830-598235bb9ffb",
  },
};

export interface XorgateCoreApiStackProps extends cdk.StackProps {
  stage: "dev" | "prod";
  // When true, EventBridge-scheduled jobs (OfflineSweeper) are deployed but
  // disabled. They poll the shared sandbox Aurora via the Data API and block
  // its auto-pause; defaults off in dev (see bin/app.ts).
  disableScheduledJobs?: boolean;
  // Arms telemetry retention in PartitionMaintenanceFn. SEPARATE from
  // disableScheduledJobs by design: turning the maintenance schedule on (which
  // dev needs, so future month partitions get created) must not start deleting
  // history as a side effect. Defaults per stage in bin/app.ts (dev ON since
  // telemetry-session-artifacts Phase 5, prod flipped by the owner);
  // `--context telemetryRetention=on|off [--context telemetryRetentionDays=90]`
  telemetryRetention?: boolean;
  telemetryRetentionDays?: number;
  // The readers' hot-window boundary (TELEMETRY_HOT_WINDOW_DAYS); defaults to
  // telemetryRetentionDays. See commonEnv.
  telemetryHotWindowDays?: number;
  // xorgate-webhooks rollout switch (README Q15, Phase 1). When false, emitters
  // still write outbox rows but nothing is enqueued and the tick does not
  // re-enqueue (WEBHOOKS_DISPATCH=off). Defaults per stage in bin/app.ts
  // (dev on, prod off until Phase 5); `--context webhooks=on|off`.
  webhooks?: boolean;
  // Deploy the dev-only WebhookEchoFn receiver (a Function URL, auth NONE) for
  // tests (README D8). Refused on prod. `--context webhookEcho=on|off`.
  webhookEcho?: boolean;
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
  /**
   * Ceiling role for scoped live credentials (platform-auth Phase 4). Created
   * in the IoT stack next to the browser role; passed as an ARN string rather
   * than an IRole because it is only ever named in a policy and in an env var.
   */
  liveVendRoleArn: string;
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
  /** Public origin of xorgate-web for this stage, for links inside emails. */
  appUrl: string;
  /** The API's own SES sends (src/services/email.ts). */
  email: {
    /** `Name <address>` header form, e.g. `xorgate <no-reply@xorgate.io>`. */
    from: string;
    identityArn: string;
    configurationSetName: string;
    configurationSetArn: string;
  };
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
      liveVendRoleArn,
      recorderClusterArn,
      recorderClusterName,
      recorderSecurityGroupId,
      recorderSubnets,
      engineTaskFamily,
      engineTaskRoleArn,
      engineExecutionRoleArn,
      engineContainerName,
      appUrl,
      email,
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
          // Tenancy attributes (`xgOrgId`/`xgWorkspaceId`) that the device
          // policy's scoped-telemetry topic variables resolve against
          // (platform-auth Phase 4, services/device-scope.ts).
          "iot:UpdateThing",
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
          // Device teardown (services/device-teardown.ts) removes a deleted
          // device's channels rather than leaving them to bill forever.
          "kinesisvideo:DeleteSignalingChannel",
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
    // Device simulator (plans/xorgate-device-simulator): one provision bundle
    // per simulated device at xorgate/sim-devices/<deviceId> — written by the
    // create route, read by the sim-host plane, deleted by device teardown
    // (DevicesFn, WorkspacesFn, OrganizationsFn, MeFn all reach it) — and the
    // hand-rotated sim-host bearer token, read-only. Name-pattern grants:
    // Secrets Manager suffixes the ARN.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "SimDeviceBundleSecrets",
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:DeleteSecret",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:xorgate/sim-devices/*`,
        ],
      }),
    );
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "SimHostTokenRead",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:xorgate/sim-host-token*`,
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
    // DetachPolicy is the revoke half (DELETE /live/access and the last-membership
    // removal path); same target-shaped authorization, same fixed policy name.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "IotAttachBrowserPolicy",
        actions: ["iot:AttachPolicy", "iot:DetachPolicy"],
        resources: ["*"],
      }),
    );
    // Scoped live-credential vending (platform-auth Phase 4). The ceiling role
    // trusts this account and delegates to identity policies, so THIS statement
    // is the gate on who may vend — keep it to the one role ARN. `sts:TagSession`
    // is deliberately NOT granted: scoping is carried by the inline session
    // policy, and a principal tag that nothing reads is a trap for whoever adds
    // a tag-conditioned statement later.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "LiveCredentialVend",
        actions: ["sts:AssumeRole"],
        resources: [liveVendRoleArn],
      }),
    );
    // Video scoping is a tag condition on the signalling channel, so the vend
    // path has to be able to write those tags. Read is granted alongside for
    // operator debugging; nothing in the code path calls it.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "KvsScopeTags",
        actions: ["kinesisvideo:TagResource", "kinesisvideo:ListTagsForResource"],
        resources: [`arn:aws:kinesisvideo:${this.region}:${this.account}:channel/*`],
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
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminGetUser",
          // DELETE /me (handlers/me.ts): resolve the pool username from the
          // token's sub, then remove the account.
          "cognito-idp:ListUsers",
          "cognito-idp:AdminDeleteUser",
        ],
        resources: [
          `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${userPoolId}`,
        ],
      }),
    );

    // Outbound email sent by the API itself (src/services/email.ts), confined
    // to the verified sending identity and its configuration set. Cognito's
    // own mails do not go through this — the pool sends those under the
    // identity policy granted in email-stack.ts.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "SesSendTransactionalEmail",
        actions: ["ses:SendEmail"],
        resources: [email.identityArn, email.configurationSetArn],
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

    // --- Webhooks (plans/xorgate-webhooks, Phase 1, README D4) ---------------
    // Two queues, the WorkflowRunQueue shape: fan-out ({eventId} -> one
    // delivery row per endpoint) and delivery ({deliveryId, attempt} -> one
    // signed POST). DLQ after 3 receives, alarmed below. Created before
    // commonEnv so every Lambda (the emitters of Phases 2 and 3 live all over
    // the stack) gets the URLs. Visibility 60 s covers both consumers' 30 s.
    if (props.webhookEcho && isProd) {
      throw new Error("webhookEcho is a dev-only test receiver and must never deploy to prod");
    }
    const webhookFanoutDlq = new sqs.Queue(this, "WebhookFanoutDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    const webhookFanoutQueue = new sqs.Queue(this, "WebhookFanoutQueue", {
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: webhookFanoutDlq, maxReceiveCount: 3 },
    });
    const webhookDeliveryDlq = new sqs.Queue(this, "WebhookDeliveryDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    const webhookDeliveryQueue = new sqs.Queue(this, "WebhookDeliveryQueue", {
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: webhookDeliveryDlq, maxReceiveCount: 3 },
    });
    // Every emitter, the sweeper and the webhook Lambdas share lambdaRole.
    webhookFanoutQueue.grantSendMessages(lambdaRole);
    webhookDeliveryQueue.grantSendMessages(lambdaRole);

    const commonEnv: Record<string, string> = {
      NODE_ENV: isProd ? "production" : "development",
      STAGE: stage,
      // Where links inside outbound email point, and the sender they go out
      // as (src/services/email.ts).
      APP_URL: appUrl,
      EMAIL_FROM: email.from,
      EMAIL_CONFIGURATION_SET: email.configurationSetName,
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
      LIVE_VEND_ROLE_ARN: liveVendRoleArn,
      // Session policies name account-qualified ARNs, and Lambda does not set
      // the account id in the environment the way it sets AWS_REGION.
      AWS_ACCOUNT_ID: this.account,
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
      // Device-recorded MEDIA segment retention (offline recording plan, Phase
      // 6.3). Drives the sweeper's DB row expiry; MUST match the S3 lifecycle
      // age in storage-stack — both read the `segmentRetentionDays` context key.
      SEGMENT_RETENTION_DAYS: recCtx("segmentRetentionDays", "90"),
      // Recorded TELEMETRY artifact retention (telemetry-session-artifacts
      // plan, Phase 5, README D8): the `telemetry/v1/` objects are the record
      // and live 365 d; the sweeper expires telemetry_segments /
      // telemetry_sessions / telemetry_ingest_log rows one day later. MUST
      // match storage-stack, which reads the same `telemetryArtifactRetentionDays`
      // context key.
      TELEMETRY_ARTIFACT_RETENTION_DAYS: recCtx("telemetryArtifactRetentionDays", "365"),
      // The `telemetry_readings` HOT WINDOW as the READERS see it
      // (services/telemetry-window.ts): a workflow window older than this is
      // served from the S3 artifacts (plus whatever rows Postgres still has),
      // younger from Postgres alone. Defaults to the retention window so the
      // two never disagree; `--context telemetryHotWindowDays=<n>` narrows it
      // (safe in either direction: S3 is the record).
      // (90 = DEFAULT_RETENTION_DAYS in src/services/telemetry-partitions.ts.)
      TELEMETRY_HOT_WINDOW_DAYS: String(props.telemetryHotWindowDays ?? props.telemetryRetentionDays ?? 90),
      // Device-recorded media sessions (offline recording plan, Phase 4):
      // sweeper close window — no new segment ARRIVAL for this long -> closed.
      MEDIA_SESSION_CLOSE_AFTER_MS: recCtx("mediaSessionCloseAfterMs", String(10 * 60 * 1000)),
      // Monotonic media_sessions.time_source upgrade on segment ingest
      // (optimize-system-process-cycle Phase 1, Q6). Experiment flag, default
      // off; flip with `--context mediaTimeSourceUpgrade=1`.
      MEDIA_TIME_SOURCE_UPGRADE: recCtx("mediaTimeSourceUpgrade", "0"),
      // Far-future media-segment guardrail (optimize-system-process-cycle
      // Phase 8): drop segments stamped more than this far ahead of now
      // instead of silently absorbing a device's broken clock. 0 = off.
      MEDIA_SEGMENT_MAX_FUTURE_MS: recCtx(
        "mediaSegmentMaxFutureMs",
        String(24 * 60 * 60 * 1000),
      ),
      // Webhooks: read by services/webhooks/emit.ts (webhooksDispatchEnabled)
      // and deliver.ts. WEBHOOKS_DISPATCH is the rollout flag (props.webhooks).
      WEBHOOK_FANOUT_QUEUE_URL: webhookFanoutQueue.queueUrl,
      WEBHOOK_DELIVERY_QUEUE_URL: webhookDeliveryQueue.queueUrl,
      WEBHOOKS_DISPATCH: props.webhooks ? "on" : "off",
    };

    // The workflow engine (@xorgate/workflow-engine) locates its own
    // package.json and dist/runtime/ at run time, so it cannot be bundled into
    // a single esbuild output: it is external in EVERY Lambda bundle (every
    // workflow handler pulls the catalog in) and INSTALLED into each asset as
    // real node_modules from the lockfile (`nodeModules`). zod and
    // zod-to-json-schema ride along so the handler code and the package share
    // one physical zod (the handlers compose package schemas into their own).
    // The package's optional dependencies (onnxruntime-node ~283 MB unpacked,
    // @anthropic-ai/sdk) are omitted at install time: they belong to the
    // Fargate image only, the Lambda target refuses media graphs pre-flight,
    // and the package requires them lazily so their absence is never touched.
    // They stay external (with mqtt, live-ingest on the container only) so
    // esbuild never tries to follow a lazy require into them.
    const enginePackage = "@xorgate/workflow-engine";
    const engineNodeModules = [enginePackage, "zod", "zod-to-json-schema"];
    const engineExternals = [enginePackage, "onnxruntime-node", "@anthropic-ai/sdk", "mqtt"];
    const commonBundling: nodejs.BundlingOptions = {
      minify: true,
      sourceMap: true,
      target: "node20",
      externalModules: ["@aws-sdk/*", ...engineExternals],
      nodeModules: engineNodeModules,
      // Applied to the asset's `npm ci` by the local bundler (and the Docker
      // fallback): optional dependencies are not installed.
      environment: { npm_config_omit: "optional" },
      forceDockerBundling: false,
    };

    // @aws-sdk/client-ecs and client-sqs are not guaranteed to be in the Lambda
    // runtime's bundled SDK (unlike client-s3 / client-rds-data), so any Lambda
    // that launches/stops Fargate tasks or enqueues workflow runs bundles the
    // SDK rather than externalize it.
    const bundlingWithSdk: nodejs.BundlingOptions = {
      ...commonBundling,
      externalModules: engineExternals,
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

    // Destroy paths (DELETE /me, /organizations/{id}, /workspaces/{id},
    // /devices/{id}) tear down IoT things, KVS channels and S3 prefixes before
    // the row delete (services/device-teardown.ts). The S3 drain is budgeted
    // per device, but an organization with several devices still needs more
    // than the 10 s default; 28 s stays inside API Gateway's 29 s.
    const destroyTimeout = cdk.Duration.seconds(28);

    const meFn = new nodejs.NodejsFunction(this, "MeFn", {
      ...standardFnProps(
        path.join(entryBase, "me.ts"),
        "/me — current user + memberships, profile name and picture, account deletion",
      ),
      // Bundles @aws-sdk/client-cognito-identity-provider for DELETE /me
      // (ListUsers + AdminDeleteUser), same reason as the memberships fn.
      bundling: bundlingWithSdk,
      timeout: destroyTimeout,
    });

    const organizationsFn = new nodejs.NodejsFunction(this, "OrganizationsFn", {
      ...standardFnProps(
        path.join(entryBase, "organizations.ts"),
        "CRUD /organizations (DELETE tears down every device under it)",
      ),
      timeout: destroyTimeout,
      // Bundles @aws-sdk/client-kinesis-video via services/device-teardown.ts,
      // which isn't guaranteed in the Lambda runtime SDK.
      bundling: bundlingWithSdk,
    });

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

    // POST /auth/session-tokens — exchange an `xg_` key for a short-lived
    // `xgs_` token a third party's browser may hold (platform-auth Phase 3).
    // Calls iot:DescribeEndpoint once per container so the response can carry
    // the live-plane coordinates; that grant is already on the shared role for
    // device provisioning.
    const authSessionTokensFn = new nodejs.NodejsFunction(
      this,
      "AuthSessionTokensFn",
      standardFnProps(
        path.join(entryBase, "auth-session-tokens.ts"),
        "POST /auth/session-tokens — mint a short-lived session token",
      ),
    );

    // POST /auth/live-credentials — exchange a xorgate credential for AWS
    // credentials scoped to one org/workspace's live plane (platform-auth
    // Phase 4). Calls sts:AssumeRole with an inline session policy, tags
    // signalling channels on the way through, and reuses the DescribeEndpoint
    // grant the token endpoint already relies on.
    const authLiveCredentialsFn = new nodejs.NodejsFunction(this, "AuthLiveCredentialsFn", {
      ...standardFnProps(
        path.join(entryBase, "auth-live-credentials.ts"),
        "POST /auth/live-credentials — vend scoped live-plane credentials",
      ),
      // Bundles @aws-sdk/client-sts and @aws-sdk/client-kinesis-video, neither
      // of which is guaranteed in the Lambda runtime SDK.
      bundling: bundlingWithSdk,
    });

    const workspacesFn = new nodejs.NodejsFunction(this, "WorkspacesFn", {
      ...standardFnProps(
        path.join(entryBase, "workspaces.ts"),
        "CRUD /workspaces (DELETE tears down every device in it)",
      ),
      timeout: destroyTimeout,
      // Bundles @aws-sdk/client-kinesis-video via services/device-teardown.ts,
      // which isn't guaranteed in the Lambda runtime SDK.
      bundling: bundlingWithSdk,
    });

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
      timeout: destroyTimeout,
      // Bundles @aws-sdk/client-iot-data-plane (retained device-config publish),
      // which isn't guaranteed in the Lambda runtime SDK.
      bundling: bundlingWithSdk,
    });

    // Device transfer (plans/transfer-device-ownership). Its own function rather
    // than another arm of DevicesFn: the ordered sequence makes an IoT publish, an
    // IoT UpdateThing and a KVS re-tag on one request, and it must not share a
    // cold start (or a timeout) with the settings-save path. 30 s for the same
    // reason DeviceProvisioningFn has it — several AWS round-trips per request.
    const deviceTransferFn = new nodejs.NodejsFunction(this, "DeviceTransferFn", {
      ...standardFnProps(
        path.join(entryBase, "device-transfer.ts"),
        "POST /devices/{id}/transfer + transfer offers — move a device between tenancies",
      ),
      timeout: cdk.Duration.seconds(30),
      // Bundles @aws-sdk/client-iot-data-plane (the retained config publish),
      // @aws-sdk/client-iot (the thing attributes) and
      // @aws-sdk/client-kinesis-video (the channel re-tag).
      bundling: bundlingWithSdk,
    });

    const deviceCommandsFn = new nodejs.NodejsFunction(this, "DeviceCommandsFn", {
      ...standardFnProps(
        path.join(entryBase, "device-commands.ts"),
        "POST /devices/{id}/reboot|power-off|refresh-state — one-shot device commands",
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
      // Bundles @aws-sdk/client-iot-data-plane: the claim seeds the retained
      // config topic for the new device (same reason DevicesFn bundles it).
      bundling: bundlingWithSdk,
    });

    // Device simulator (plans/xorgate-device-simulator, Phase 3). The create
    // route provisions like a claim (thing, cert, KVS channels, config publish)
    // AND stores the provision bundle in Secrets Manager, and its rollback runs
    // the device teardown primitive — so it gets the destroy timeout and the
    // same bundled SDK clients as DevicesFn.
    const deviceSimulationsFn = new nodejs.NodejsFunction(this, "DeviceSimulationsFn", {
      ...standardFnProps(
        path.join(entryBase, "device-simulations.ts"),
        "device simulations — create/get/start + scenario catalog",
      ),
      timeout: destroyTimeout,
      bundling: bundlingWithSdk,
    });

    // The sim-host plane (/sim-hosts/*): authenticated ONLY by the dedicated
    // SIM_HOST_TOKEN secret (README Q10), never by a user credential. Reads the
    // desired list, presigns the demo-assets pack, serves provision bundles,
    // takes heartbeats.
    const simHostsFn = new nodejs.NodejsFunction(this, "SimHostsFn", {
      ...standardFnProps(
        path.join(entryBase, "sim-hosts.ts"),
        "sim-host plane — desired/scenarios/bundles/heartbeat (SIM_HOST_TOKEN)",
      ),
      bundling: bundlingWithSdk,
    });
    simHostsFn.addEnvironment("SIM_HOST_TOKEN_SECRET", "xorgate/sim-host-token");

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

    // GET /device-dist/latest — the CI-published build manifest, so the web UI
    // can say "update available" instead of only showing what is installed.
    // Read is scoped to the one key: this Lambda has no business with the
    // tarballs themselves.
    const deviceDistFn = new nodejs.NodejsFunction(
      this,
      "DeviceDistFn",
      standardFnProps(
        path.join(entryBase, "device-dist.ts"),
        "GET /device-dist/latest — latest published agent build manifest",
      ),
    );
    deviceDistFn.addEnvironment("DEVICE_DIST_BUCKET", distBucket.bucketName);
    distBucket.grantRead(deviceDistFn, "latest.json");

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
        "GET /devices/{id}/telemetry(+/latest,/recent,/readings,/sessions) — historical telemetry reads",
      ),
      // Range queries scan monthly partitions; give them more headroom than the default.
      memorySize: 256,
      // Backstop only — every query here is index-bounded and returns in well
      // under a second. 25 s is chosen against the RDS Data API's own ~45 s
      // cancellation: a request that outlives 25 s is a query bug, not a
      // capacity problem, and should surface as a Lambda timeout rather than be
      // masked by a longer budget. (Was 15 s, which the old unbounded
      // count(distinct ts) on /telemetry/readings blew through as a 500.)
      timeout: cdk.Duration.seconds(25),
      // xorgate-webhooks P3: close-on-read emits telemetry_session.ended and
      // enqueues it (client-sqs).
      bundling: bundlingWithSdk,
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
        "Schedule (1m) -> offline sweep + media/telemetry-session close + overview build + segment expiry",
      ),
      // Telemetry-session overview builds (telemetry-session-artifacts plan,
      // Phase 1): up to 10 per tick, each streaming a session's segments from
      // S3 through the builder. The S3 grants come from the shared
      // lambdaRole's bucket.grantReadWrite above (GET segments, PUT
      // overview.*, and the CopyObject that normalises segment metadata).
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      bundling: bundlingWithSdk,
      // JSON log records (telemetry-session-artifacts P6 item 8): the build
      // lines below are logged as one object each, which the runtime emits as
      // `message: { msg, ms, gzipBytes, ... }` so the metric filters can select
      // and extract fields. Text-format lines stay readable in the console.
      loggingFormat: lambda.LoggingFormat.JSON,
    });
    new events.Rule(this, "OfflineSweeperSchedule", {
      description: "Housekeeping: offline sweep + media-session close (P2 telemetry / offline recording)",
      enabled: !props.disableScheduledJobs,
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(offlineSweeperFn)],
    });

    // --- Telemetry overview builds: metrics, one alarm, one dashboard row ---
    // (telemetry-session-artifacts P6 item 8). Metric filters on the sweeper's
    // log group; the group is referenced by NAME, not through `fn.logGroup`
    // (which would add a LogRetention custom resource and force INFINITE
    // retention). The group must exist before the filters are created, which
    // it does on every stage that has invoked the function once; a brand-new
    // stage deploys the function, invokes it (the schedule), then adds these on
    // the next deploy. The `msg` strings are the contract with
    // services/telemetry-sessions.ts BUILD_LOG_MSG / BUILD_FAILED_LOG_MSG.
    const sweeperLogGroup = logs.LogGroup.fromLogGroupName(
      this,
      "OfflineSweeperLogGroup",
      `/aws/lambda/${offlineSweeperFn.functionName}`,
    );
    const artifactMetricsNamespace = "Xorgate/TelemetryArtifacts";
    const builtPattern = logs.FilterPattern.stringValue("$.message.msg", "=", "telemetry-sessions: overview built");
    const overviewBuilds = new logs.MetricFilter(this, "TelemetryOverviewBuildsFilter", {
      logGroup: sweeperLogGroup,
      metricNamespace: artifactMetricsNamespace,
      metricName: "OverviewBuilds",
      filterPattern: builtPattern,
      metricValue: "1",
    });
    const overviewBuildMs = new logs.MetricFilter(this, "TelemetryOverviewBuildMsFilter", {
      logGroup: sweeperLogGroup,
      metricNamespace: artifactMetricsNamespace,
      metricName: "OverviewBuildMs",
      filterPattern: builtPattern,
      metricValue: "$.message.ms",
    });
    const overviewBytes = new logs.MetricFilter(this, "TelemetryOverviewBytesFilter", {
      logGroup: sweeperLogGroup,
      metricNamespace: artifactMetricsNamespace,
      metricName: "OverviewGzipBytes",
      filterPattern: builtPattern,
      metricValue: "$.message.gzipBytes",
    });
    // The failure line is matched as a plain term so it fires under either log
    // format (the value is the count, not a field). No dimensions on any of
    // these: a metric filter only accepts JSON-selector dimension values and a
    // term pattern accepts none, and the stages are separate accounts anyway.
    const overviewBuildFailures = new logs.MetricFilter(this, "TelemetryOverviewBuildFailuresFilter", {
      logGroup: sweeperLogGroup,
      metricNamespace: artifactMetricsNamespace,
      metricName: "OverviewBuildFailures",
      filterPattern: logs.FilterPattern.literal('"overview build failed"'),
      metricValue: "1",
    });
    const overviewBuildFailureAlarm = new cloudwatch.Alarm(this, "TelemetryOverviewBuildFailureAlarm", {
      alarmDescription:
        "A telemetry session overview build failed in the sweeper (telemetry-session-artifacts). " +
        "The session stays closed with overview_key null / overview_stale and is retried every tick; " +
        "look for 'overview build failed' in the OfflineSweeperFn log for the sessionId and error.",
      metric: overviewBuildFailures.metric({ statistic: "Sum", period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    overviewBuildFailureAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
    // Also carries the webhooks row (added below, next to the webhook Lambdas):
    // one dashboard for the plane's ops metrics, no extra CFN resource.
    const opsDashboard = new cloudwatch.Dashboard(this, "TelemetryArtifactsDashboard", {
      dashboardName: `xorgate-telemetry-artifacts-${props.stage}`,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: "Overview builds / min",
            width: 8,
            left: [
              overviewBuilds.metric({ statistic: "Sum", period: cdk.Duration.minutes(1), label: "builds" }),
              overviewBuildFailures.metric({ statistic: "Sum", period: cdk.Duration.minutes(1), label: "failures", color: "#d13212" }),
            ],
          }),
          new cloudwatch.GraphWidget({
            title: "Overview build time (ms)",
            width: 8,
            left: [
              overviewBuildMs.metric({ statistic: "p50", period: cdk.Duration.minutes(5), label: "p50" }),
              overviewBuildMs.metric({ statistic: "p99", period: cdk.Duration.minutes(5), label: "p99" }),
              overviewBuildMs.metric({ statistic: "Maximum", period: cdk.Duration.minutes(5), label: "max" }),
            ],
          }),
          new cloudwatch.GraphWidget({
            title: "Overview artifact size (gzipped bytes)",
            width: 8,
            left: [
              overviewBytes.metric({ statistic: "Average", period: cdk.Duration.minutes(5), label: "avg" }),
              overviewBytes.metric({ statistic: "Maximum", period: cdk.Duration.minutes(5), label: "max" }),
            ],
          }),
        ],
      ],
    });

    // EventBridge monthly -> pre-create upcoming telemetry_readings partitions
    // (a missing month partition breaks ingestion). Mid-month cron: the +1/+2
    // partitions from the previous run still cover us if one run fails.
    //
    // The same function also owns TELEMETRY RETENTION (the `telemetry_readings`
    // hot window, telemetry-session-artifacts plan Phase 5). `telemetryRetention`
    // is a SEPARATE switch from `scheduledJobs` on purpose: dev needs the
    // schedule on so future months get created, and that must not start
    // deleting history as a side effect. Nothing is dropped unless
    // TELEMETRY_RETENTION_ENABLED is the literal string "true", so the env var
    // is omitted entirely when the flag is off rather than set to "false".
    // Window/ceiling defaults and the guardrails: src/services/telemetry-partitions.ts.
    const partitionMaintenanceFn = new nodejs.NodejsFunction(this, "PartitionMaintenanceFn", {
      ...standardFnProps(
        path.join(entryBase, "partition-maintenance.ts"),
        "Schedule (monthly) -> ensure telemetry_readings month partitions" +
          (props.telemetryRetention ? " + retention (ARMED)" : " (retention dormant)"),
      ),
      // MERGED onto commonEnv, not replacing it — standardFnProps sets
      // `environment: commonEnv` (DB_CLUSTER_ARN et al) and this function needs
      // those to reach Aurora at all.
      environment: {
        ...commonEnv,
        ...(props.telemetryRetention
          ? {
              TELEMETRY_RETENTION_ENABLED: "true",
              ...(props.telemetryRetentionDays
                ? { TELEMETRY_RETENTION_DAYS: String(props.telemetryRetentionDays) }
                : {}),
            }
          : {}),
      },
    });
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

    // --- The same ingest, on the tenant-scoped telemetry plane ---
    //
    // Devices move to `xorgate/orgs/{org}/ws/{ws}/devices/{id}/telemetry` one at
    // a time, as each receives its scope on the retained config channel
    // (platform-auth Phase 4). So for the length of the migration the fleet is
    // split across two topics and persistence has to be indifferent to which.
    //
    // A SECOND RULE rather than a widened filter, and that is forced rather
    // than stylistic: an MQTT `+` matches exactly one level, so no single
    // filter matches both a four-level and an eight-level topic, and the only
    // filter that does (`xorgate/#`) would also catch config, status, commands
    // and config-reports. Two rules, one Lambda, same DLQ, same error posture.
    // `topic(7)` is the device id here, exactly as `topic(3)` is over there, so
    // the handler cannot tell the difference.
    //
    // DELETE THIS RULE'S SIBLING, not this one, when the fleet has finished
    // moving — and not before: a device that never received its scope still
    // publishes to the legacy topic, and dropping that rule first would stop
    // persisting it, silently.
    const telemetryScopedRule = new iot.CfnTopicRule(this, "TelemetryIngestScopedRule", {
      ruleName: isProd
        ? "xorgate_telemetry_ingest_scoped"
        : "xorgate_telemetry_ingest_scoped_dev",
      topicRulePayload: {
        sql:
          "SELECT *, topic(7) AS topicDeviceId " +
          "FROM 'xorgate/orgs/+/ws/+/devices/+/telemetry'",
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

    telemetryIngestFn.addPermission("AllowScopedIotRuleInvoke", {
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      sourceArn: telemetryScopedRule.attrArn,
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
      // xorgate-webhooks P3: enqueues telemetry_session.started (client-sqs).
      bundling: bundlingWithSdk,
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
      // xorgate-webhooks P3: enqueues media_session.started, and
      // segment_uploaded triggers enqueue runs (client-sqs).
      bundling: bundlingWithSdk,
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

    // --- Session poster frames (session-thumbnails) ---
    // S3 Object Created for the FIRST segment of a session (suffix /00000.mp4;
    // the handler's key parser is the prefix/shape gate, EventBridge can't
    // combine prefix+suffix in one matcher) -> MediaThumbnailFn -> one
    // downscaled JPEG next to the segments + media_sessions.thumbnail_key,
    // which the sessions list presigns as `thumbnailUrl`. ffmpeg comes from a
    // layer holding a pinned static arm64 build; the ~50 MB binary is NOT
    // checked in — synth fails here until scripts/fetch-ffmpeg-layer.sh has
    // downloaded and checksum-verified it (npm run fetch:ffmpeg).
    const ffmpegBinary = path.join(
      __dirname,
      "../../lambda-layers/ffmpeg/bin/ffmpeg",
    );
    if (!fs.existsSync(ffmpegBinary)) {
      throw new Error(
        `MediaThumbnailFn ffmpeg layer binary is missing (${ffmpegBinary}). ` +
          "Run `npm run fetch:ffmpeg` once, then synth/deploy again.",
      );
    }
    const ffmpegLayer = new lambda.LayerVersion(this, "FfmpegLayer", {
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../lambda-layers/ffmpeg"),
      ),
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description:
        "Static ffmpeg (ffmpeg-static b6.0, linux-arm64) at /opt/bin/ffmpeg",
    });
    const mediaThumbnailFnDlq = new sqs.Queue(this, "MediaThumbnailFnDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    const mediaThumbnailFn = new nodejs.NodejsFunction(this, "MediaThumbnailFn", {
      ...standardFnProps(
        path.join(entryBase, "media-thumbnail.ts"),
        "S3 Object Created(media-sessions/v1/**/00000.mp4) -> session poster frame",
      ),
      // Downloads one whole segment (<= ~20 MB) to /tmp and decodes a single
      // 1080p frame; memory also buys the CPU the decode runs on.
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      layers: [ffmpegLayer],
      environment: { ...commonEnv, FFMPEG_PATH: "/opt/bin/ffmpeg" },
      onFailure: new lambdaDestinations.SqsDestination(mediaThumbnailFnDlq),
    });
    const mediaThumbnailRuleDlq = new sqs.Queue(this, "MediaThumbnailRuleDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    new events.Rule(this, "MediaThumbnailRule", {
      description: "First video segment uploaded -> extract session poster frame",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: { name: [bucket.bucketName] },
          object: { key: [{ suffix: "/00000.mp4" }] },
        },
      },
      targets: [
        new targets.LambdaFunction(mediaThumbnailFn, {
          deadLetterQueue: mediaThumbnailRuleDlq,
          retryAttempts: 2,
        }),
      ],
    });
    const mediaThumbnailDlqAlarm = new cloudwatch.Alarm(this, "MediaThumbnailDlqDepthAlarm", {
      metric: mediaThumbnailFnDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "MediaThumbnailFn async invoke failed past retries (session poster frame not generated)",
    });
    mediaThumbnailDlqAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

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
    //
    // xorgate-webhooks P2: a status flip now also writes the device.online /
    // device.offline outbox row and enqueues it, so this bundles client-sqs
    // and gets the function-level onFailure DLQ it never had (README §10): a
    // Lambda that threw past its retries (DB down) left a flip AND its event
    // unrecorded, which the rule's errorAction below does not catch.
    const deviceStatusFnDlq = new sqs.Queue(this, "DeviceStatusFnDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    const deviceStatusFn = new nodejs.NodejsFunction(this, "DeviceStatusFn", {
      ...standardFnProps(
        path.join(entryBase, "device-status.ts"),
        "IoT rule -> device status (LWT) + device.online/offline webhooks",
      ),
      timeout: cdk.Duration.seconds(20),
      bundling: bundlingWithSdk,
      onFailure: new lambdaDestinations.SqsDestination(deviceStatusFnDlq),
    });
    const deviceStatusDlqAlarm = new cloudwatch.Alarm(this, "DeviceStatusFnDlqDepthAlarm", {
      metric: deviceStatusFnDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "DeviceStatusFn async invoke failed past retries (status flip / presence webhook not recorded)",
    });
    deviceStatusDlqAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

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

    // --- Device config REPORT mirror (improve_device_settings_management,
    // Phase 3): IoT Topic Rule -> Lambda -> devices.reported_config ---
    // The agent publishes what it ACTUALLY applied to
    // xorgate/devices/<id>/config/reported after every apply, on connect, and
    // hourly. Mirroring it is what lets the UI say applied/adjusted/rejected
    // instead of only "saved", and a report whose rev trails config_rev makes
    // the Lambda republish the retained desired document — the self-heal that
    // replaces the old 502 "re-save to retry" crutch.
    //
    // Bundles client-iot-data-plane for that republish. NO new IAM: the shared
    // lambdaRole already carries iot:Publish + iot:RetainPublish on
    // topic/xorgate/devices/*/config (sid IotPublishDeviceConfig above) — the
    // same grant the devices handler publishes with.
    const deviceConfigReportFnDlq = new sqs.Queue(this, "DeviceConfigReportFnDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    const deviceConfigReportFn = new nodejs.NodejsFunction(this, "DeviceConfigReportFn", {
      ...standardFnProps(
        path.join(entryBase, "device-config-report.ts"),
        "IoT rule -> devices.reported_config (+ republish desired when the device is behind)",
      ),
      timeout: cdk.Duration.seconds(20),
      bundling: bundlingWithSdk,
      // Captures a Lambda that ran and threw past its retries (DB down) — the
      // failure the RULE DLQ below does not catch. Same two-layer posture as
      // the telemetry path.
      onFailure: new lambdaDestinations.SqsDestination(deviceConfigReportFnDlq),
    });

    const deviceConfigReportDlqAlarm = new cloudwatch.Alarm(
      this,
      "DeviceConfigReportFnDlqDepthAlarm",
      {
        metric: deviceConfigReportFnDlq.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          "DeviceConfigReportFn async invoke failed past retries (reported config not mirrored)",
      },
    );
    deviceConfigReportDlqAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    const deviceConfigReportRule = new iot.CfnTopicRule(this, "DeviceConfigReportRule", {
      ruleName: isProd ? "xorgate_device_config_report" : "xorgate_device_config_report_dev",
      topicRulePayload: {
        // topic(3) is the deviceId — `config/reported` occupies segments 4-5.
        sql: "SELECT *, topic(3) AS topicDeviceId FROM 'xorgate/devices/+/config/reported'",
        awsIotSqlVersion: "2016-03-23",
        ruleDisabled: false,
        actions: [{ lambda: { functionArn: deviceConfigReportFn.functionArn } }],
        // Reuse the low-volume telemetry rule DLQ + role (one error sink, one
        // alarm), exactly as the device status rule above does.
        errorAction: {
          sqs: {
            queueUrl: telemetryDlq.queueUrl,
            roleArn: telemetryRuleRole.roleArn,
            useBase64: false,
          },
        },
      },
    });

    deviceConfigReportFn.addPermission("AllowIotRuleInvoke", {
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      sourceArn: deviceConfigReportRule.attrArn,
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

    // The revoke half. Named live/access, not iot/detach-policy: consumer-facing
    // surfaces must not require knowing xorgate runs on AWS IoT (design note
    // N11). The grant keeps its older AWS-shaped path until the /v1 cut folds
    // both into /v1/live/access.
    const liveAccessFn = new nodejs.NodejsFunction(
      this,
      "LiveAccessFn",
      standardFnProps(
        path.join(entryBase, "live-access.ts"),
        "DELETE /live/access — revoke the caller's own live-plane access",
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
      // xorgate-webhooks P2: enqueues workflow.event outbox rows (client-sqs).
      bundling: bundlingWithSdk,
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
    // --- Webhook Lambdas (xorgate-webhooks Phase 1) ---------------------------
    // WebhooksFn serves the whole REST surface (endpoints, deliveries, the event
    // catalog AND the device routes) from one function and one integration: the
    // stack sits near CloudFormation's 500-resource cap, so no second Lambda.
    // Bundles the SDK (client-sqs for test/redeliver, client-secrets-manager for
    // the endpoint secrets under xorgate/orgs/<orgId>/webhooks/*).
    const webhooksFn = new nodejs.NodejsFunction(this, "WebhooksFn", {
      ...standardFnProps(
        path.join(entryBase, "webhooks.ts"),
        "webhook endpoints, deliveries, event types, device routes",
      ),
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      bundling: bundlingWithSdk,
    });
    const webhookFanoutFn = new nodejs.NodejsFunction(this, "WebhookFanoutFn", {
      ...standardFnProps(
        path.join(entryBase, "webhook-fanout.ts"),
        "SQS -> webhook outbox row -> one delivery per routed endpoint",
      ),
      timeout: cdk.Duration.seconds(30),
      bundling: bundlingWithSdk,
    });
    webhookFanoutFn.addEventSource(
      new lambdaEventSources.SqsEventSource(webhookFanoutQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
    const webhookDeliverFn = new nodejs.NodejsFunction(this, "WebhookDeliverFn", {
      ...standardFnProps(
        path.join(entryBase, "webhook-deliver.ts"),
        "SQS -> one signed webhook POST (10 s timeout, no redirects) + retry schedule",
      ),
      // One 10 s POST plus a handful of Data API statements.
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      bundling: bundlingWithSdk,
      // JSON so the per-attempt `{msg: "webhooks", …}` line is selectable as
      // $.message.* by the metric filters below (deliver.ts deliveryLogLine).
      loggingFormat: lambda.LoggingFormat.JSON,
    });
    webhookDeliverFn.addEventSource(
      new lambdaEventSources.SqsEventSource(webhookDeliveryQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
    for (const [id, dlq, what] of [
      ["WebhookFanoutDlqDepthAlarm", webhookFanoutDlq, "fan-out"],
      ["WebhookDeliveryDlqDepthAlarm", webhookDeliveryDlq, "delivery"],
    ] as const) {
      const alarm = new cloudwatch.Alarm(this, id, {
        metric: dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `Webhook ${what} messages failed 3 receives and landed in the DLQ (a database error, not an endpoint failure)`,
      });
      alarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
    }
    // Delivery metrics (Phase 5) from the one JSON line per attempt
    // (services/webhooks/deliver.ts DELIVERY_LOG_MSG + deliveryLogLine). Same
    // by-name log group reference as the overview-build filters above: the
    // group must exist before the filters deploy, i.e. the function has been
    // invoked once on the stage. `outcome` is delivered | retry | failed |
    // exhausted; a 0-result delivery (skipped) logs no such line.
    const webhookDeliverLogGroup = logs.LogGroup.fromLogGroupName(
      this,
      "WebhookDeliverLogGroup",
      `/aws/lambda/${webhookDeliverFn.functionName}`,
    );
    const webhookMetricsNamespace = "Xorgate/Webhooks";
    const deliveryPattern = logs.FilterPattern.stringValue("$.message.msg", "=", "webhooks");
    const webhookAttempts = new logs.MetricFilter(this, "WebhookDeliveryAttemptsFilter", {
      logGroup: webhookDeliverLogGroup,
      metricNamespace: webhookMetricsNamespace,
      metricName: "DeliveryAttempts",
      filterPattern: deliveryPattern,
      metricValue: "1",
      dimensions: { outcome: "$.message.outcome" },
    });
    const webhookAttemptMs = new logs.MetricFilter(this, "WebhookDeliveryMsFilter", {
      logGroup: webhookDeliverLogGroup,
      metricNamespace: webhookMetricsNamespace,
      metricName: "DeliveryMs",
      filterPattern: deliveryPattern,
      metricValue: "$.message.ms",
    });
    const perMinute = { statistic: "Sum", period: cdk.Duration.minutes(1) };
    opsDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Webhook delivery attempts / min",
        width: 6,
        left: (
          [
            ["delivered", "#2ca02c"],
            ["retry", "#ff7f0e"],
            ["failed", "#9467bd"],
            ["exhausted", "#d13212"],
          ] as const
        ).map(([outcome, color]) =>
          webhookAttempts.metric({ ...perMinute, dimensionsMap: { outcome }, label: outcome, color }),
        ),
      }),
      new cloudwatch.GraphWidget({
        title: "Webhook POST time (ms)",
        width: 6,
        left: [
          webhookAttemptMs.metric({ statistic: "p50", period: cdk.Duration.minutes(5), label: "p50" }),
          webhookAttemptMs.metric({ statistic: "p99", period: cdk.Duration.minutes(5), label: "p99" }),
          webhookAttemptMs.metric({ statistic: "Maximum", period: cdk.Duration.minutes(5), label: "max" }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "Webhook queues (visible messages)",
        width: 6,
        left: [
          webhookFanoutQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), label: "fan-out" }),
          webhookDeliveryQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), label: "delivery" }),
        ],
        right: [
          webhookFanoutDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), label: "fan-out DLQ", color: "#d13212" }),
          webhookDeliveryDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), label: "delivery DLQ", color: "#9467bd" }),
          deviceStatusFnDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), label: "DeviceStatusFn DLQ", color: "#8c564b" }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "Webhook Lambda errors / min",
        width: 6,
        left: [
          webhookFanoutFn.metricErrors({ ...perMinute, label: "fan-out" }),
          webhookDeliverFn.metricErrors({ ...perMinute, label: "deliver" }),
          deviceStatusFn.metricErrors({ ...perMinute, label: "device-status" }),
        ],
      }),
    );

    // Dev-only test receiver (README D8): never a public third-party receiver.
    if (props.webhookEcho) {
      const webhookEchoFn = new nodejs.NodejsFunction(this, "WebhookEchoFn", {
        ...standardFnProps(
          path.join(entryBase, "webhook-echo.ts"),
          "DEV ONLY: logs webhook requests, answers 204 (or ?status=)",
          false,
        ),
        environment: { STAGE: stage },
      });
      const echoUrl = webhookEchoFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
      new cdk.CfnOutput(this, "WebhookEchoUrl", {
        value: echoUrl.url,
        description: "Dev-only webhook echo receiver (logs to /aws/lambda/<WebhookEchoFn>)",
      });
      new cdk.CfnOutput(this, "WebhookEchoFunctionName", { value: webhookEchoFn.functionName });
    }

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

    // --- Models (xorgate-models plan, M2): datasets, items, annotations,
    // imports, versions, and the organization model registry read. ---
    // Datasets handler: DB + S3 (presigned POST for uploads, sha256 probe on
    // register, presigned GETs on list) + SQS (imports and version builds are
    // queued). Register streams up to 50 objects of up to 20 MiB per call, so
    // it gets the 30 s API Gateway ceiling and memory for the hash.
    const datasetsFn = new nodejs.NodejsFunction(this, "DatasetsFn", {
      ...standardFnProps(
        path.join(entryBase, "datasets.ts"),
        "CRUD /datasets(+items, annotations, imports, versions)",
      ),
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      bundling: bundlingWithSdk,
    });
    // Merged model read (platform manifests + org_models rows), archive and
    // delete, presigned downloads. S3 read comes from the shared role's
    // bucket grant.
    const modelsFn = new nodejs.NodejsFunction(this, "ModelsFn", {
      ...standardFnProps(
        path.join(entryBase, "models.ts"),
        "GET /models (merged registry), PATCH|DELETE /models/{id}, download",
      ),
      timeout: cdk.Duration.seconds(20),
      memorySize: 256,
    });
    // One queue for every Models job kind (import | version_build now; train |
    // autolabel in M3), the WorkflowRunQueue shape: DLQ after 3 receives, a
    // visibility timeout past the dispatcher's 15-minute budget.
    const modelJobDlq = new sqs.Queue(this, "ModelJobDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    const modelJobQueue = new sqs.Queue(this, "ModelJobQueue", {
      visibilityTimeout: cdk.Duration.seconds(960),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: modelJobDlq, maxReceiveCount: 3 },
    });
    modelJobQueue.grantSendMessages(lambdaRole);
    // The dispatcher claims the owning row (dispatched_at) and runs the job:
    // a version build copies images server-side and writes the three files;
    // a recording import downloads segments, samples frames with the ffmpeg
    // layer and chunks across invocations through the same queue. Full
    // 15-minute budget, ephemeral storage for a 60 s segment plus its frames.
    const modelJobDispatchFn = new nodejs.NodejsFunction(this, "ModelJobDispatchFn", {
      ...standardFnProps(
        path.join(entryBase, "model-job-dispatch.ts"),
        "SQS -> claim + run Models jobs (import | version_build | train | autolabel) and device purges",
      ),
      timeout: cdk.Duration.minutes(15),
      memorySize: 1536,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      layers: [ffmpegLayer],
      environment: { ...commonEnv, FFMPEG_PATH: "/opt/bin/ffmpeg" },
      bundling: bundlingWithSdk,
    });
    modelJobDispatchFn.addEventSource(
      new lambdaEventSources.SqsEventSource(modelJobQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
    modelJobDispatchFn.addEnvironment("MODEL_JOB_QUEUE_URL", modelJobQueue.queueUrl);
    datasetsFn.addEnvironment("MODEL_JOB_QUEUE_URL", modelJobQueue.queueUrl);
    // `POST /devices/{id}/purges` hands the device data purge to the same queue.
    devicesFn.addEnvironment("MODEL_JOB_QUEUE_URL", modelJobQueue.queueUrl);

    // --- Models M3: training and assist jobs on SageMaker ---------------------
    // The forge image lives in a repo of this account, retagged out of band
    // from ghcr.io/epyelabs/xmf (the same discipline as engine-runner). The
    // name and the URI are literals so the execution role's ECR grant and the
    // dispatcher's env var never create a construct dependency.
    const forgeRepoName = isProd
      ? "xorgate-model-forge"
      : "xorgate-model-forge-dev";
    // The forge release the platform runs (xorgate-model-forge CHANGELOG):
    // 0.2.0 reports the operating confidence in result v1. The tag must exist
    // in the stage's forge ECR repo before a deploy, or every job fails at
    // the image pull.
    const forgeImageTag = this.node.tryGetContext("forgeImageTag") ?? "0.2.0";
    const forgeImageUri = `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${forgeRepoName}:${forgeImageTag}`;
    new ecr.Repository(this, "ForgeRepo", {
      repositoryName: forgeRepoName,
      // The image is pushed by hand and rolled back by retagging; keep both
      // tags around, and expire nothing automatically.
      imageScanOnPush: false,
      emptyOnDelete: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // The role SageMaker assumes to run a forge container. It reaches exactly
    // three prefixes of the core bucket and nothing else: no database, no
    // secrets, no IoT. Design §4d.
    const forgeExecutionRoleName = isProd
      ? "XorgateForgeExecutionRole"
      : "XorgateForgeExecutionRoleDev";
    const forgeExecutionRoleArn = `arn:aws:iam::${this.account}:role/${forgeExecutionRoleName}`;
    const forgeExecutionRole = new iam.Role(this, "ForgeExecutionRole", {
      roleName: forgeExecutionRoleName,
      assumedBy: new iam.ServicePrincipal("sagemaker.amazonaws.com"),
      description:
        "Execution role for xorgate-model-forge SageMaker training jobs (datasets read, training write)",
    });
    forgeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ForgeEcrPull",
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ],
        resources: [
          `arn:aws:ecr:${this.region}:${this.account}:repository/${forgeRepoName}`,
        ],
      }),
    );
    forgeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        // GetAuthorizationToken has no resource-level scoping.
        sid: "ForgeEcrAuth",
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    forgeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ForgeLogs",
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/sagemaker/TrainingJobs*`,
        ],
      }),
    );
    forgeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        // Training metrics; the action has no resource-level scoping.
        sid: "ForgeMetrics",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      }),
    );
    forgeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ForgeReadInputs",
        actions: ["s3:GetObject"],
        resources: [
          `arn:aws:s3:::${bucket.bucketName}/datasets/*`,
          `arn:aws:s3:::${bucket.bucketName}/training/*`,
          `arn:aws:s3:::${bucket.bucketName}/org-models/*`,
          `arn:aws:s3:::${bucket.bucketName}/models/*`,
        ],
      }),
    );
    forgeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        // Only the job's own tree: the output tarball and the synced
        // checkpoints directory (progress.jsonl).
        sid: "ForgeWriteOutputs",
        actions: ["s3:PutObject"],
        resources: [`arn:aws:s3:::${bucket.bucketName}/training/*`],
      }),
    );
    forgeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        // S3Prefix channels list before they download.
        sid: "ForgeListInputs",
        actions: ["s3:ListBucket"],
        resources: [`arn:aws:s3:::${bucket.bucketName}`],
        conditions: {
          StringLike: {
            "s3:prefix": [
              "datasets/*",
              "training/*",
              "org-models/*",
              "models/*",
            ],
          },
        },
      }),
    );

    // The shared Lambda role starts, stops and describes forge jobs, and may
    // pass the forge execution role to SageMaker and to nothing else. Literal
    // ARNs (shared-role rule).
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ForgeTrainingJobs",
        actions: [
          "sagemaker:CreateTrainingJob",
          "sagemaker:StopTrainingJob",
          "sagemaker:DescribeTrainingJob",
          "sagemaker:AddTags",
        ],
        resources: [
          `arn:aws:sagemaker:${this.region}:${this.account}:training-job/xorgate-forge-${stage}-*`,
        ],
      }),
    );
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ForgePassRole",
        actions: ["iam:PassRole"],
        resources: [forgeExecutionRoleArn],
        conditions: {
          StringEquals: { "iam:PassedToService": "sagemaker.amazonaws.com" },
        },
      }),
    );

    // Training-jobs API: start, list, detail (progress tail + artifact index),
    // cancel, presigned artifact reads. Bundles the AWS SDK (SageMaker stop).
    const trainingJobsFn = new nodejs.NodejsFunction(this, "TrainingJobsFn", {
      ...standardFnProps(
        path.join(entryBase, "training-jobs.ts"),
        "CRUD /training-jobs (+progress, cancel, artifact-url)",
      ),
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      bundling: bundlingWithSdk,
    });

    // SageMaker state changes -> the row. A terminal event downloads
    // model.tar.gz, mirrors it into training/<jobId>/artifacts/ and publishes
    // the model, so it needs room for the archive in memory and on disk.
    const modelJobFinalizeFn = new nodejs.NodejsFunction(this, "ModelJobFinalizeFn", {
      ...standardFnProps(
        path.join(entryBase, "model-job-finalize.ts"),
        "SageMaker state change -> finalize a training/assist job",
      ),
      timeout: cdk.Duration.minutes(10),
      memorySize: 3008,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      bundling: bundlingWithSdk,
    });
    new events.Rule(this, "ForgeTrainingJobStateRule", {
      description:
        "SageMaker training job state change (xorgate-forge jobs) -> finalize the row",
      eventPattern: {
        source: ["aws.sagemaker"],
        detailType: ["SageMaker Training Job State Change"],
        detail: {
          TrainingJobName: [{ prefix: `xorgate-forge-${stage}-` }],
        },
      },
      targets: [new targets.LambdaFunction(modelJobFinalizeFn)],
    });

    // The dispatcher writes the job spec and calls CreateTrainingJob; the
    // training-jobs handler stops one. Both need the image and the role.
    for (const fn of [modelJobDispatchFn, trainingJobsFn, datasetsFn]) {
      fn.addEnvironment("FORGE_IMAGE_URI", forgeImageUri);
      fn.addEnvironment("FORGE_EXECUTION_ROLE_ARN", forgeExecutionRoleArn);
    }
    trainingJobsFn.addEnvironment("MODEL_JOB_QUEUE_URL", modelJobQueue.queueUrl);

    new cdk.CfnOutput(this, "ForgeRepositoryUri", {
      value: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${forgeRepoName}`,
      description: "ECR repository the forge image is retagged into (out of band)",
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

    // CORS: the API answers every origin, deliberately.
    //
    // Phase 5 of plans/platform-auth-and-live-plane evaluated a per-org
    // registered-origin allowlist (design note N3) and the user's call was not
    // to build it. Two measured facts and one structural one decided it:
    //
    // 1. Per-response enforcement is IMPOSSIBLE while `corsPreflight` is set.
    //    Measured on dev 2026-08-18: with CORS configured on an HTTP API,
    //    API Gateway strips the integration's `Access-Control-*` headers and
    //    substitutes its own, even for an origin its own list does not match.
    //    So N3's "option 1" (wildcard preflight + enforcement in the response
    //    helper) enforces nothing, and the obvious hybrid (static preflight
    //    list + handler-computed header for everyone else) does not work
    //    either. Enforcing per-org would mean dropping `corsPreflight`
    //    entirely and answering OPTIONS from Lambda.
    // 2. There is nothing for CORS to protect. CORS guards AMBIENT browser
    //    credentials. This API has none: no cookie is read or written
    //    anywhere, auth is the `Authorization` header alone
    //    (src/middleware/auth.ts), and `allowCredentials` is unset (false),
    //    which a wildcard requires. A hostile page cannot obtain a victim's
    //    token, and anything that HAS the token can call this API from a
    //    server, where CORS does not exist.
    // 3. A preflight carries no credential, so an allowlist could never be
    //    consulted per-org at preflight time anyway; and enforcing it on the
    //    real request would turn every expired-token 401 into a "blocked by
    //    CORS policy" console error instead of a readable `401`.
    //
    // The security boundary is auth, and Phases 2 to 4 are what make that
    // defensible: every browser-holdable credential is now verified,
    // short-lived and scoped. The consumer-facing benefit N3 actually wanted,
    // namely that a third-party app's origin works without a xorgate deploy,
    // is delivered in full by the wildcard.
    //
    // DO NOT set `allowCredentials: true` here. Wildcard + credentials is
    // rejected by browsers, and it is the combination that would make the
    // reasoning above false. test/cors-config.test.ts fails the build on it.
    this.api = new apigwv2.HttpApi(this, "XorgateCoreApi", {
      apiName: isProd ? "xorgate-core-api" : "xorgate-core-api-dev",
      description: "Xorgate core backend HTTP API",
      corsPreflight: {
        allowOrigins: ["*"],
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
          // The annotator's optimistic-concurrency token on
          // PUT /datasets/{id}/items/{itemId}/annotations (xorgate-models
          // M4). Without it the browser's preflight fails and the PUT never
          // leaves the page; curl (the M2 E2E) sends no preflight.
          "If-Match",
        ],
        exposeHeaders: ["ETag"],
        maxAge: cdk.Duration.hours(24),
      },
    });

    // Gateway throttling (sdk-packages-and-alocate-pilot Q7, extracted from
    // the Phase 5 productization bundle and shipped early, USER 2026-08-21).
    //
    // The exposure this closes is not a malicious third party; it is a
    // runaway loop in a CONSUMER'S dev environment, which as of Phase 3
    // points at this production API and its pay-per-ACU database. Stage-wide
    // token bucket, no per-key notion: per-key quotas remain Phase 5's, where
    // they become the thing that lets tiers be sold.
    //
    // 50 rps steady / 100 burst is an order of magnitude above anything the
    // first-party frontend or the pilot consumer legitimately does, and an
    // order of magnitude below what a tight retry loop reaches. A throttled
    // caller gets a bare 429 (no Retry-After on HTTP API throttles);
    // @xorgate/sdk >= 0.1.1 treats 429 as retryable with backoff, which is
    // why the SDK shipped 429-aware before this did.
    //
    // The L2 HttpApi does not expose default-stage route settings, so this is
    // the documented CfnStage escape hatch.
    const defaultStage = this.api.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    defaultStage.defaultRouteSettings = {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 100,
    };

    // Every route integration goes through this helper. By default
    // HttpLambdaIntegration adds one AWS::Lambda::Permission PER ROUTE, so each
    // route cost two CloudFormation resources and this stack reached 497 of
    // the hard 500-resource cap (2026-10-01, plans/xorgate-device-simulator).
    // `scopePermissionToRoute: false` makes it one permission per function,
    // scoped to this API (`<apiId>/*/*/*`): ~120 resources back, and a new
    // route now costs one. Only routes declared here can reach the function,
    // so the wider source ARN grants nothing new. Do NOT construct
    // HttpLambdaIntegration directly: test/api-stack-budget.test.ts fails the
    // build if you do.
    const lambdaInt = (id: string, fn: lambda.IFunction) =>
      new apigwv2int.HttpLambdaIntegration(id, fn, { scopePermissionToRoute: false });

    // The 500 cap is a hard CloudFormation quota, and the first sign of it used
    // to be a failed deploy. Count at synth instead: warn with headroom left,
    // fail synth (not the deploy) past the cap. Runs after every construct is
    // added, so the lazily-created route permissions are included.
    const RESOURCE_CAP = 500;
    const RESOURCE_WARN = 450;
    this.node.addValidation({
      validate: () => {
        const count = this.node
          .findAll()
          .filter((c) => c instanceof cdk.CfnResource && cdk.Stack.of(c) === this).length;
        if (count > RESOURCE_CAP) {
          return [`${count} CloudFormation resources, over the hard cap of ${RESOURCE_CAP}`];
        }
        if (count > RESOURCE_WARN) {
          cdk.Annotations.of(this).addWarningV2(
            "xorgate:stack-resource-budget",
            `${count} of ${RESOURCE_CAP} CloudFormation resources; plan a split before adding more`,
          );
        }
        return [];
      },
    });

    const healthInt = lambdaInt(
      "HealthInt",
      healthFn,
    );
    const meInt = lambdaInt("MeInt", meFn);
    const organizationsInt = lambdaInt(
      "OrganizationsInt",
      organizationsFn,
    );
    const membershipsInt = lambdaInt(
      "MembershipsInt",
      membershipsFn,
    );
    const apiKeysInt = lambdaInt(
      "ApiKeysInt",
      apiKeysFn,
    );
    const authSessionTokensInt = lambdaInt(
      "AuthSessionTokensInt",
      authSessionTokensFn,
    );
    const authLiveCredentialsInt = lambdaInt(
      "AuthLiveCredentialsInt",
      authLiveCredentialsFn,
    );
    const workspacesInt = lambdaInt(
      "WorkspacesInt",
      workspacesFn,
    );
    const deviceModelsInt = lambdaInt(
      "DeviceModelsInt",
      deviceModelsFn,
    );
    const devicesInt = lambdaInt(
      "DevicesInt",
      devicesFn,
    );
    const deviceTransferInt = lambdaInt(
      "DeviceTransferInt",
      deviceTransferFn,
    );
    const deviceSimulationsInt = lambdaInt(
      "DeviceSimulationsInt",
      deviceSimulationsFn,
    );
    const simHostsInt = lambdaInt("SimHostsInt", simHostsFn);
    const deviceCommandsInt = lambdaInt(
      "DeviceCommandsInt",
      deviceCommandsFn,
    );
    const searchInt = lambdaInt(
      "SearchInt",
      searchFn,
    );
    const deviceProvisioningInt = lambdaInt(
      "DeviceProvisioningInt",
      deviceProvisioningFn,
    );
    const deviceRegistrationsInt = lambdaInt(
      "DeviceRegistrationsInt",
      deviceRegistrationsFn,
    );
    const installScriptInt = lambdaInt(
      "InstallScriptInt",
      installScriptFn,
    );
    const deviceDistInt = lambdaInt(
      "DeviceDistInt",
      deviceDistFn,
    );
    const deviceKvsChannelsInt = lambdaInt(
      "DeviceKvsChannelsInt",
      deviceKvsChannelsFn,
    );
    const deviceIdentityInt = lambdaInt(
      "DeviceIdentityInt",
      deviceIdentityFn,
    );
    const telemetryHistoryInt = lambdaInt(
      "TelemetryHistoryInt",
      telemetryHistoryFn,
    );
    const deviceSessionsInt = lambdaInt(
      "DeviceSessionsInt",
      deviceSessionsFn,
    );
    const iotAttachPolicyInt = lambdaInt(
      "IotAttachPolicyInt",
      iotAttachPolicyFn,
    );
    const liveAccessInt = lambdaInt(
      "LiveAccessInt",
      liveAccessFn,
    );
    const workflowTemplatesInt = lambdaInt(
      "WorkflowTemplatesInt",
      workflowTemplatesFn,
    );
    const workflowCatalogInt = lambdaInt(
      "WorkflowCatalogInt",
      workflowCatalogFn,
    );
    const modelRegistryInt = lambdaInt(
      "ModelRegistryInt",
      modelRegistryFn,
    );
    const deviceWorkflowsInt = lambdaInt(
      "DeviceWorkflowsInt",
      deviceWorkflowsFn,
    );
    const workflowRunsInt = lambdaInt(
      "WorkflowRunsInt",
      workflowRunsFn,
    );
    const workflowSimulationsInt = lambdaInt(
      "WorkflowSimulationsInt",
      workflowSimulationsFn,
    );
    const organizationCredentialsInt = lambdaInt(
      "OrganizationCredentialsInt",
      organizationCredentialsFn,
    );
    const datasetsInt = lambdaInt("DatasetsInt", datasetsFn);
    const modelsInt = lambdaInt("ModelsInt", modelsFn);
    const trainingJobsInt = lambdaInt(
      "TrainingJobsInt",
      trainingJobsFn,
    );
    const docsInt = lambdaInt("DocsInt", docsFn);
    const webhooksInt = lambdaInt("WebhooksInt", webhooksFn);

    // Inject the API base into the docs Lambda now that the api exists. The
    // public hostname wins when there is one: `servers` in the served document
    // is the URL a reader is meant to copy, and the `execute-api` name is an
    // implementation detail. It is a BARE origin — the document's path keys
    // carry `/v1` themselves (src/openapi/index.ts explains why).
    docsFn.addEnvironment(
      "DOCS_BASE_URL",
      CUSTOM_DOMAINS[stage]
        ? `https://${CUSTOM_DOMAINS[stage]!.hostname}`
        : this.api.apiEndpoint,
    );

    // Device-registration Lambdas need the public API base to build the install
    // URL and the claim URL baked into install.sh. Same chicken-and-egg as
    // DOCS_BASE_URL — inject it now that `this.api` exists. No DNS yet, so this
    // is the generated execute-api endpoint.
    deviceRegistrationsFn.addEnvironment("API_BASE_URL", this.api.apiEndpoint);
    installScriptFn.addEnvironment("API_BASE_URL", this.api.apiEndpoint);

    // ---------------------------------------------------------------------
    // The route table. EVERY route is served under `/v1`, and only under `/v1`.
    //
    // Between 2026-08-19 and 2026-08-19 each route was also declared at its bare
    // unversioned path, as a deprecated alias, so that xorgate-web did not have
    // to move in the same release as the version cut. Those aliases are gone:
    // xorgate-web is the only consumer of this API and it now calls `/v1`.
    //
    // Do NOT call `this.api.addRoutes` directly. The guard test fails the build
    // if you do, because a route declared outside this helper skips the prefix
    // and would be reachable at a name this API no longer serves.
    const addRoutes = (props: {
      path: string;
      methods: apigwv2.HttpMethod[];
      integration: apigwv2.HttpRouteIntegration;
    }) => {
      this.api.addRoutes({
        path: `/v1${props.path}`,
        methods: props.methods,
        integration: props.integration,
      });
    };

    addRoutes({
      path: "/health",
      methods: [apigwv2.HttpMethod.GET],
      integration: healthInt,
    });

    addRoutes({
      path: "/me",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      integration: meInt,
    });
    // Profile picture. Bytes land as base64 on the PUT and are stored in the
    // core bucket under `avatars/` — the shared lambdaRole's grantReadWrite on
    // that bucket already covers it, so there is no new grant here.
    addRoutes({
      path: "/me/avatar",
      methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration: meInt,
    });

    addRoutes({
      path: "/organizations",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: organizationsInt,
    });
    addRoutes({
      path: "/organizations/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: organizationsInt,
    });
    // Organization logo. Same storage as the profile picture above — base64 in
    // the body, private object under `logos/organizations/` in the core bucket
    // — so the shared lambdaRole's grantReadWrite already covers it.
    addRoutes({
      path: "/organizations/{id}/logo",
      methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration: organizationsInt,
    });

    addRoutes({
      path: "/memberships",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: membershipsInt,
    });
    addRoutes({
      path: "/memberships/{id}",
      methods: [apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      integration: membershipsInt,
    });

    addRoutes({
      path: "/api-keys",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: apiKeysInt,
    });
    addRoutes({
      path: "/api-keys/{id}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: apiKeysInt,
    });

    // Webhooks (xorgate-webhooks Phase 1). All on WebhooksFn, device routes too.
    addRoutes({
      path: "/webhooks",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: webhooksInt,
    });
    addRoutes({
      path: "/webhooks/{id}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      integration: webhooksInt,
    });
    addRoutes({
      path: "/webhooks/{id}/test",
      methods: [apigwv2.HttpMethod.POST],
      integration: webhooksInt,
    });
    addRoutes({
      path: "/webhooks/{id}/rotate-secret",
      methods: [apigwv2.HttpMethod.POST],
      integration: webhooksInt,
    });
    addRoutes({
      path: "/webhooks/{id}/deliveries",
      methods: [apigwv2.HttpMethod.GET],
      integration: webhooksInt,
    });
    addRoutes({
      path: "/webhooks/{id}/deliveries/{deliveryId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: webhooksInt,
    });
    addRoutes({
      path: "/webhooks/{id}/deliveries/{deliveryId}/redeliver",
      methods: [apigwv2.HttpMethod.POST],
      integration: webhooksInt,
    });
    addRoutes({
      path: "/webhook-event-types",
      methods: [apigwv2.HttpMethod.GET],
      integration: webhooksInt,
    });
    addRoutes({
      path: "/devices/{id}/webhooks",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT],
      integration: webhooksInt,
    });

    addRoutes({
      path: "/auth/session-tokens",
      methods: [apigwv2.HttpMethod.POST],
      integration: authSessionTokensInt,
    });
    addRoutes({
      path: "/auth/live-credentials",
      methods: [apigwv2.HttpMethod.POST],
      integration: authLiveCredentialsInt,
    });

    addRoutes({
      path: "/workspaces",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: workspacesInt,
    });
    addRoutes({
      path: "/workspaces/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: workspacesInt,
    });
    // Workspace logo, under `logos/workspaces/` in the same bucket.
    addRoutes({
      path: "/workspaces/{id}/logo",
      methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration: workspacesInt,
    });

    addRoutes({
      path: "/device-models",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: deviceModelsInt,
    });
    addRoutes({
      path: "/device-models/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: deviceModelsInt,
    });

    addRoutes({
      path: "/search",
      methods: [apigwv2.HttpMethod.GET],
      integration: searchInt,
    });

    addRoutes({
      path: "/devices",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: devicesInt,
    });
    addRoutes({
      path: "/devices/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: devicesInt,
    });
    // Config writes are their own routes (improve_device_settings_management,
    // Phase 2): PATCH /config validates + publishes the retained document and
    // bumps config_rev; PATCH /ui-prefs is cloud-only and does neither. Both go
    // to the devices Lambda, which dispatches on event.routeKey.
    addRoutes({
      path: "/devices/{id}/config",
      methods: [apigwv2.HttpMethod.PATCH],
      integration: devicesInt,
    });
    addRoutes({
      path: "/devices/{id}/ui-prefs",
      methods: [apigwv2.HttpMethod.PATCH],
      integration: devicesInt,
    });
    // Transfer. `preview` is a read with no writes — it is what lets the
    // confirmation dialog NAME the workflow attachments a cross-org move will
    // detach, before the operator confirms rather than after.
    addRoutes({
      path: "/devices/{id}/transfer",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceTransferInt,
    });
    addRoutes({
      path: "/devices/{id}/transfer/preview",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceTransferInt,
    });
    // Device data purge (plans/device-wf-data-delete): wipe attached workflows
    // and their runs, recorded telemetry and recorded media, keeping the device.
    // Served by the devices Lambda with its own gates (owner|admin; the POST
    // refuses workspace-scoped tokens like a transfer). The POST records a
    // `device_purges` row and hands the work to the ModelJobQueue worker;
    // `preview` is the read the confirmation dialog shows counts from. The
    // static `/preview` segment is matched ahead of `/{purgeId}` by the HTTP
    // API's most-specific-route rule.
    addRoutes({
      path: "/devices/{id}/purges",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: devicesInt,
    });
    addRoutes({
      path: "/devices/{id}/purges/preview",
      methods: [apigwv2.HttpMethod.GET],
      integration: devicesInt,
    });
    addRoutes({
      path: "/devices/{id}/purges/{purgeId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: devicesInt,
    });
    // Cross-organization handover. The device-scoped route mints a code; the
    // `/transfer-offers/{code}` routes are reached by an organization that has
    // no relationship to the device at all, so the CODE is the authorization.
    // One path parameter name across all of them (`{code}`, never `{id}`): two
    // routes on the same path template that differ only in the parameter's name
    // is a conflict API Gateway has no good answer for.
    addRoutes({
      path: "/devices/{id}/transfer-offers",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: deviceTransferInt,
    });
    addRoutes({
      path: "/transfer-offers",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceTransferInt,
    });
    addRoutes({
      path: "/transfer-offers/{code}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.DELETE],
      integration: deviceTransferInt,
    });
    addRoutes({
      path: "/transfer-offers/{code}/accept",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceTransferInt,
    });
    addRoutes({
      path: "/transfer-offers/{code}/decline",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceTransferInt,
    });

    addRoutes({
      path: "/devices/{id}/provision",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceProvisioningInt,
    });
    // One-shot commands. Separate routes rather than one /commands endpoint so
    // each action is independently visible in the route table and in docs.
    addRoutes({
      path: "/devices/{id}/reboot",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceCommandsInt,
    });
    addRoutes({
      path: "/devices/{id}/power-off",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceCommandsInt,
    });
    addRoutes({
      path: "/devices/{id}/refresh-state",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceCommandsInt,
    });
    addRoutes({
      path: "/devices/{id}/update",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceCommandsInt,
    });

    // Fleet-wide, not per-device: what the newest published agent build is.
    addRoutes({
      path: "/device-dist/latest",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceDistInt,
    });

    // Device simulator (plans/xorgate-device-simulator). Operator routes take a
    // normal user/API-key credential; `{id}` is the device id. `/scenarios` is
    // a literal segment, which HTTP API matches ahead of `{id}`.
    addRoutes({
      path: "/device-simulations",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceSimulationsInt,
    });
    addRoutes({
      path: "/device-simulations/scenarios",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceSimulationsInt,
    });
    addRoutes({
      path: "/device-simulations/{id}",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceSimulationsInt,
    });
    addRoutes({
      path: "/device-simulations/{id}/start",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceSimulationsInt,
    });
    // The sim-host plane: SIM_HOST_TOKEN only (handler-enforced; the gateway
    // has no authorizer). ONE proxy route for its four operations, on purpose:
    // every route here costs two CloudFormation resources (the route and its
    // own Lambda permission) and this stack sits at the 500-resource limit
    // (497 on dev with this route). The handler dispatches GET desired |
    // GET scenarios | GET bundles/{deviceId} | POST heartbeat and 404s the
    // rest. Undocumented by classification (src/openapi/scope.ts).
    addRoutes({
      path: "/sim-hosts/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: simHostsInt,
    });

    // Device registration (onboarding). The {code}/claim route is reached
    // unauthenticated by install.sh — the handler skips auth for it.
    addRoutes({
      path: "/device-registrations",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceRegistrationsInt,
    });
    addRoutes({
      path: "/device-registrations/{code}",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceRegistrationsInt,
    });
    addRoutes({
      path: "/device-registrations/{code}/claim",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceRegistrationsInt,
    });
    addRoutes({
      path: "/get/{code}",
      methods: [apigwv2.HttpMethod.GET],
      integration: installScriptInt,
    });
    // The N11 rename, now the only name: `kvs-channels` is gone.
    addRoutes({
      path: "/devices/{id}/video-channels",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceKvsChannelsInt,
    });
    addRoutes({
      path: "/devices/{id}/identity",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceIdentityInt,
    });
    // Device-recorded media sessions (offline recording plan, Phase 4;
    // DELETE added in Phase 6.3).
    addRoutes({
      path: "/devices/{id}/sessions",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceSessionsInt,
    });
    addRoutes({
      path: "/devices/{id}/sessions/{sessionId}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: deviceSessionsInt,
    });
    addRoutes({
      path: "/devices/{id}/sessions/{sessionId}/segments",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceSessionsInt,
    });
    addRoutes({
      path: "/devices/{id}/sessions/{sessionId}/segments/{seq}/playback",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceSessionsInt,
    });
    // Replay manifest (Composite Replays plan, Phase 2): gap-aware timeline +
    // batch-presigned segment URLs, one response per replay (R3).
    addRoutes({
      path: "/devices/{id}/replay-manifest",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceSessionsInt,
    });
    addRoutes({
      path: "/devices/{id}/telemetry",
      methods: [apigwv2.HttpMethod.GET],
      integration: telemetryHistoryInt,
    });
    addRoutes({
      path: "/devices/{id}/telemetry/latest",
      methods: [apigwv2.HttpMethod.GET],
      integration: telemetryHistoryInt,
    });
    addRoutes({
      path: "/devices/{id}/telemetry/recent",
      methods: [apigwv2.HttpMethod.GET],
      integration: telemetryHistoryInt,
    });
    addRoutes({
      path: "/devices/{id}/telemetry/readings",
      methods: [apigwv2.HttpMethod.GET],
      integration: telemetryHistoryInt,
    });
    // Recorded-telemetry session index + insights (telemetry-session-artifacts
    // plan, Phase 2). Reads the two P1 index tables only; no S3, no new IAM.
    addRoutes({
      path: "/devices/{id}/telemetry/sessions",
      methods: [apigwv2.HttpMethod.GET],
      integration: telemetryHistoryInt,
    });
    // Windowed distance / moving time from the overview artifacts (the media
    // run roll-up's read). One S3 GET per overlapping built session; the
    // shared lambdaRole already reads the bucket.
    addRoutes({
      path: "/devices/{id}/telemetry/insights",
      methods: [apigwv2.HttpMethod.GET],
      integration: telemetryHistoryInt,
    });

    // The other N11 rename, now the only name: `iot/attach-policy` is gone.
    // Grant and revoke share a path but not a Lambda: the grant needs org
    // membership and the revoke deliberately does not (Phase 1).
    addRoutes({
      path: "/live/access",
      methods: [apigwv2.HttpMethod.POST],
      integration: iotAttachPolicyInt,
    });
    addRoutes({
      path: "/live/access",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: liveAccessInt,
    });

    // Workflow templates (org-scoped) + versioning.
    addRoutes({
      path: "/workflow-templates",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: workflowTemplatesInt,
    });
    // Literal, so it is selected ahead of `/workflow-templates/{id}`: the org's
    // distinct tags with counts, for a picker.
    addRoutes({
      path: "/workflow-templates/tags",
      methods: [apigwv2.HttpMethod.GET],
      integration: workflowTemplatesInt,
    });
    addRoutes({
      path: "/workflow-templates/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: workflowTemplatesInt,
    });
    addRoutes({
      path: "/workflow-templates/{id}/draft",
      methods: [apigwv2.HttpMethod.PUT],
      integration: workflowTemplatesInt,
    });
    addRoutes({
      path: "/workflow-templates/{id}/versions/{versionId}/publish",
      methods: [apigwv2.HttpMethod.POST],
      integration: workflowTemplatesInt,
    });
    addRoutes({
      path: "/workflow-templates/{id}/versions/{versionId}/restore",
      methods: [apigwv2.HttpMethod.POST],
      integration: workflowTemplatesInt,
    });
    addRoutes({
      path: "/workflow-templates/{id}/usage",
      methods: [apigwv2.HttpMethod.GET],
      integration: workflowTemplatesInt,
    });

    // Simulator (M3): create a simulation run / presign an input upload.
    addRoutes({
      path: "/workflow-templates/{id}/simulations",
      methods: [apigwv2.HttpMethod.POST],
      integration: workflowSimulationsInt,
    });
    addRoutes({
      path: "/workflow-templates/{id}/simulations/uploads",
      methods: [apigwv2.HttpMethod.POST],
      integration: workflowSimulationsInt,
    });

    // Per-org connector credentials (M7).
    addRoutes({
      path: "/organization-credentials",
      methods: [apigwv2.HttpMethod.GET],
      integration: organizationCredentialsInt,
    });
    addRoutes({
      path: "/organization-credentials/{provider}",
      methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration: organizationCredentialsInt,
    });
    addRoutes({
      path: "/organization-credentials/{provider}/validate",
      methods: [apigwv2.HttpMethod.POST],
      integration: organizationCredentialsInt,
    });

    // Served node catalog (static per deployment, ETag cached).
    addRoutes({
      path: "/workflow-catalog",
      methods: [apigwv2.HttpMethod.GET],
      integration: workflowCatalogInt,
    });

    // Model registry (model pickers in node config forms).
    addRoutes({
      path: "/model-registry",
      methods: [apigwv2.HttpMethod.GET],
      integration: modelRegistryInt,
    });

    // Device workflow attachments.
    addRoutes({
      path: "/devices/{id}/workflows",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: deviceWorkflowsInt,
    });
    addRoutes({
      path: "/devices/{id}/workflows/{attachmentId}",
      methods: [apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      integration: deviceWorkflowsInt,
    });
    addRoutes({
      path: "/devices/{id}/workflows/{attachmentId}/run",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceWorkflowsInt,
    });

    // Workflow runs (read + rerun).
    addRoutes({
      path: "/workflow-runs",
      methods: [apigwv2.HttpMethod.GET],
      integration: workflowRunsInt,
    });
    addRoutes({
      path: "/workflow-runs/{id}",
      methods: [apigwv2.HttpMethod.GET],
      integration: workflowRunsInt,
    });
    addRoutes({
      path: "/workflow-runs/{id}/rerun",
      methods: [apigwv2.HttpMethod.POST],
      integration: workflowRunsInt,
    });
    // Presigned GET for v2 run artifacts (Data Capture downloads etc., M3).
    addRoutes({
      path: "/workflow-runs/{id}/artifact-url",
      methods: [apigwv2.HttpMethod.GET],
      integration: workflowRunsInt,
    });
    addRoutes({
      path: "/devices/{id}/workflow-runs",
      methods: [apigwv2.HttpMethod.GET],
      integration: workflowRunsInt,
    });

    // Models: datasets (xorgate-models M2). Literal segments (`items/uploads`)
    // are selected ahead of the `{itemId}` variable by the HTTP API.
    addRoutes({
      path: "/datasets",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: datasetsInt,
    });
    addRoutes({
      path: "/datasets/{id}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      integration: datasetsInt,
    });
    addRoutes({
      path: "/datasets/{id}/items",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: datasetsInt,
    });
    addRoutes({
      path: "/datasets/{id}/items/uploads",
      methods: [apigwv2.HttpMethod.POST],
      integration: datasetsInt,
    });
    addRoutes({
      path: "/datasets/{id}/items/{itemId}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: datasetsInt,
    });
    addRoutes({
      path: "/datasets/{id}/items/{itemId}/annotations",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT],
      integration: datasetsInt,
    });
    addRoutes({
      path: "/datasets/{id}/imports",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: datasetsInt,
    });
    addRoutes({
      path: "/datasets/{id}/imports/{importId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: datasetsInt,
    });
    addRoutes({
      path: "/datasets/{id}/versions",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: datasetsInt,
    });
    addRoutes({
      path: "/datasets/{id}/versions/{version}",
      methods: [apigwv2.HttpMethod.GET],
      integration: datasetsInt,
    });
    // Presigned GET for one object of a version, gated to the version prefix.
    addRoutes({
      path: "/datasets/{id}/versions/{version}/artifact-url",
      methods: [apigwv2.HttpMethod.GET],
      integration: datasetsInt,
    });
    // Models: assist (an autolabel job on the dataset's own items).
    addRoutes({
      path: "/datasets/{id}/assist",
      methods: [apigwv2.HttpMethod.POST],
      integration: datasetsInt,
    });
    // Models: training and assist jobs (M3).
    addRoutes({
      path: "/training-jobs",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: trainingJobsInt,
    });
    addRoutes({
      path: "/training-jobs/{id}",
      methods: [apigwv2.HttpMethod.GET],
      integration: trainingJobsInt,
    });
    addRoutes({
      path: "/training-jobs/{id}/cancel",
      methods: [apigwv2.HttpMethod.POST],
      integration: trainingJobsInt,
    });
    addRoutes({
      path: "/training-jobs/{id}/artifact-url",
      methods: [apigwv2.HttpMethod.GET],
      integration: trainingJobsInt,
    });
    // Models: the merged registry read and the org-model lifecycle.
    addRoutes({
      path: "/models",
      methods: [apigwv2.HttpMethod.GET],
      integration: modelsInt,
    });
    addRoutes({
      path: "/models/{id}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      integration: modelsInt,
    });
    addRoutes({
      path: "/models/{id}/download",
      methods: [apigwv2.HttpMethod.GET],
      integration: modelsInt,
    });

    addRoutes({
      path: "/docs",
      methods: [apigwv2.HttpMethod.GET],
      integration: docsInt,
    });
    addRoutes({
      path: "/openapi.json",
      methods: [apigwv2.HttpMethod.GET],
      integration: docsInt,
    });

    // Custom domain. A ROOT mapping (no `ApiMappingKey`), because `/v1` is in
    // the route table above: the domain and the version are independent, so the
    // hostname can arrive late, move, or be removed without touching a route.
    const customDomain = CUSTOM_DOMAINS[stage];
    if (customDomain) {
      const domainName = new apigwv2.DomainName(this, "ApiDomain", {
        domainName: customDomain.hostname,
        certificate: acm.Certificate.fromCertificateArn(
          this,
          "ApiDomainCert",
          customDomain.certificateArn,
        ),
        // HTTP APIs can only map to a regional domain on TLS 1.2.
        securityPolicy: apigwv2.SecurityPolicy.TLS_1_2,
      });

      new apigwv2.ApiMapping(this, "ApiDomainMapping", {
        api: this.api,
        domainName,
      });

      // What the user points a Cloudflare CNAME at. DNS is not in this account,
      // so the record is a manual step and this output is the handoff.
      new cdk.CfnOutput(this, "ApiDomainTarget", {
        value: domainName.regionalDomainName,
        description: `CNAME target for ${customDomain.hostname}`,
      });
      new cdk.CfnOutput(this, "ApiPublicUrl", {
        value: `https://${customDomain.hostname}/v1`,
        description: "Public, versioned API base URL",
      });
    }

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
