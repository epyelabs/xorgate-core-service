import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface XorgateCoreRecorderStackProps extends cdk.StackProps {
  stage: 'dev' | 'prod';
  // Core bucket; the engine runner reads device-recorded media segments from
  // media-sessions/v1/ and writes v2 run artifacts under workflows/v2/.
  bucket: s3.Bucket;
  /**
   * An existing VPC to run Fargate tasks in. Prod passes the storage stack's,
   * which already has the public subnets these tasks need; dev passes nothing
   * and gets a dedicated one, because dev's storage stack builds no VPC.
   *
   * This is not just tidiness. The account is at the default limit of 5 VPCs
   * per region, and a first prod deploy failed here with "The maximum number of
   * VPCs has been reached" (2026-08-19) while trying to make a second one for a
   * single environment.
   */
  vpc?: ec2.IVpc;
}

/**
 * Shared Fargate infra: a dedicated public-subnet VPC, security group and ECS
 * cluster, plus the v2 TS engine runner that workflows dispatch onto.
 *
 * ⚠️ The stack (and the `Recorder*` construct ids inside it) are named after the
 * cloud KVS viewer-recorder that once lived here. That recorder was removed in
 * destroy-kvs-recorder Phase 5 — its ECR repo, log group, task role and task
 * definition are gone — but the VPC/SG/cluster it introduced are SHARED with the
 * engine runner, so they stay under their original ids (renaming them would
 * replace live infrastructure). Nothing named `Recorder*` here is recorder-owned
 * any more; treat them as the shared Fargate plane.
 *
 * The engine-runner image lives in this stack's `EngineRunnerRepo` (built +
 * pushed out-of-band from the service root). The api-stack's Lambdas launch/stop
 * tasks here (RunTask/StopTask) using the exported ARNs.
 *
 * Networking: no NAT gateway (tasks get a public IP and reach S3/KVS/TURN
 * directly) keeps cost down for the PoC.
 */
export class XorgateCoreRecorderStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly publicSubnetIds: string[];
  // v2 TS engine runner (M2) — reuses this stack's cluster/VPC/SG.
  public readonly engineRepository: ecr.Repository;
  public readonly engineTaskDefinition: ecs.FargateTaskDefinition;
  public readonly engineContainerName = 'engine-runner';
  public readonly engineTaskFamily: string;
  public readonly engineTaskRoleArn: string;
  public readonly engineExecutionRoleArn: string;

  constructor(scope: Construct, id: string, props: XorgateCoreRecorderStackProps) {
    super(scope, id, props);

    const { stage, bucket } = props;
    const isProd = stage === 'prod';
    const suffix = isProd ? '' : 'Dev';
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // Reuse the caller's VPC when given one (prod), otherwise build a
    // public-only VPC with no NAT (dev). Either way tasks get a public IP and
    // reach S3/KVS/TURN directly, which is what keeps the NAT gateway off the
    // bill in both stages.
    const vpc =
      props.vpc ??
      new ec2.Vpc(this, 'RecorderVpc', {
        maxAzs: 2,
        natGateways: 0,
        subnetConfiguration: [
          { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        ],
      });

    this.securityGroup = new ec2.SecurityGroup(this, 'RecorderSG', {
      vpc,
      description: 'Xorgate recorder Fargate tasks (egress only)',
      allowAllOutbound: true,
    });

    this.cluster = new ecs.Cluster(this, 'RecorderCluster', {
      clusterName: isProd ? 'xorgate-recorder' : 'xorgate-recorder-dev',
      vpc,
    });

    this.publicSubnetIds = vpc.publicSubnets.map((s) => s.subnetId);

    // (Cloud KVS viewer-recorder constructs REMOVED in destroy-kvs-recorder
    // Phase 5: RecorderRepo (ECR), RecorderLogs, RecorderTaskRole + its
    // KvsViewer/MediaS3Upload/IotPublishStatus/IotDescribeEndpoint policies,
    // RecorderTaskDef + its 'recorder' container, the taskRoleArn/
    // executionRoleArn exports and the RecorderRepoUri output. The VPC, SG,
    // cluster and publicSubnetIds above stayed — they are shared with the
    // engine runner below. ⚠️ The two deleted role ARNs were cross-stack
    // auto-exports the api stack imported for RecorderPassRole, so the api
    // stack must be deployed BEFORE this one (see PROGRESS Phase 5). In prod
    // the ECR repo and log group are RETAIN, so they orphan rather than delete
    // — Phase 7 retires the image.)

    // (CV runner constructs REMOVED in M7. They were kept exactly one deploy
    // past the M6 cutover with exportValue pins because their role ARNs were
    // cross-stack auto-exports the pre-M6 api stack imported; the M6 api-stack
    // deploy landed, nothing imports them anymore. Dev repo/log group were
    // DESTROY/emptyOnDelete; prod would orphan with RETAIN. Rollback = git
    // revert + rebuild the image from the reverted cv-runner/ source.)

    // --- v2 engine runner (M2: TS streaming engine, Fargate target) ---
    // Node 20 + ffmpeg + onnxruntime-node on Fargate ARM64. Reads the v2 run
    // manifest + input media from S3, runs the SAME engine core as the Lambda
    // target, and writes frames/records/result.json under workflows/v2/runs/.
    // Reuses this stack's cluster/VPC/SG. Image built + pushed out-of-band from
    // the SERVICE ROOT (the build needs src/):
    //   docker build --platform linux/arm64 -f engine-runner/Dockerfile .
    this.engineRepository = new ecr.Repository(this, 'EngineRunnerRepo', {
      repositoryName: isProd ? 'xorgate-engine-runner' : 'xorgate-engine-runner-dev',
      removalPolicy,
      emptyOnDelete: !isProd,
      imageScanOnPush: true,
    });

    const engineLogGroup = new logs.LogGroup(this, 'EngineRunnerLogs', {
      logGroupName: isProd ? '/xorgate/engine-runner' : '/xorgate/engine-runner-dev',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy,
    });

    // Task role: read inputs (media segments, v2 manifests, the model registry),
    // write v2 run artifacts. ListBucket is needed to resolve the latest model
    // version, scoped to the registry prefix. NO DB credentials by design: a
    // media graph that needs device telemetry history fails that source.
    const engineTaskRole = new iam.Role(this, 'EngineRunnerTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Xorgate v2 engine task: read media/manifests/models, write v2 run artifacts',
    });
    engineTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EngineReadInputs',
        actions: ['s3:GetObject'],
        resources: [
          // On-device recording segments — Workflows' video input since
          // destroy-kvs-recorder Phase W. Without this every segment fetch
          // 403s mid-run.
          bucket.arnForObjects('media-sessions/v1/*'),
          bucket.arnForObjects('workflows/v2/*'),
          bucket.arnForObjects('models/*'),
          // Organization model registry roots (xorgate-models M2, design
          // §4e): the host resolves org-models/<orgId>/ before models/.
          bucket.arnForObjects('org-models/*'),
        ],
      }),
    );
    engineTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EngineListModelRegistry',
        actions: ['s3:ListBucket'],
        resources: [bucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['models/*', 'org-models/*'] } },
      }),
    );
    engineTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EngineWriteResults',
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('workflows/v2/*')],
      }),
    );
    // Progress planes: simulator runs publish under wf/sim/<orgId>/<runId>/*
    // (M3) and production triggered runs under wf/run/<orgId>/<runId>/* (M6),
    // over the resolved ATS data endpoint (DescribeEndpoint has no resource
    // scoping).
    engineTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EngineSimProgressPublish',
        actions: ['iot:Publish'],
        resources: [
          `arn:aws:iot:${this.region}:${this.account}:topic/wf/sim/*`,
          `arn:aws:iot:${this.region}:${this.account}:topic/wf/run/*`,
        ],
      }),
    );
    // M5 live ingest plane: the engine subscribes (MQTT-over-WSS, SigV4) to
    // wf/sim/<orgId>/<runId>/ingest/<nodeId> for browser-published webcam
    // frames. Broad wf/sim/* filter matches the publish stance above.
    engineTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EngineSimIngestSubscribe',
        actions: ['iot:Connect', 'iot:Subscribe', 'iot:Receive'],
        resources: [
          `arn:aws:iot:${this.region}:${this.account}:client/engine-ingest-*`,
          `arn:aws:iot:${this.region}:${this.account}:topicfilter/wf/sim/*`,
          `arn:aws:iot:${this.region}:${this.account}:topic/wf/sim/*`,
        ],
      }),
    );
    // M5 warm simulator sessions: a session task long-polls (and drains) its
    // per-editing-session queue. Name-pattern grant, matching the api-stack's
    // create/send grant on the shared Lambda role.
    engineTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EngineSessionQueuePoll',
        actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:xorgate-wfsim-${stage}-*`,
        ],
      }),
    );
    engineTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EngineIotDescribeEndpoint',
        actions: ['iot:DescribeEndpoint'],
        resources: ['*'],
      }),
    );
    // Google Roads connector API key (created OUT-OF-BAND, deploy constraint):
    // name-based ARN wildcard because Secrets Manager appends a random suffix.
    const googleRoadsSecretName = isProd
      ? 'xorgate-google-roads-api-key'
      : 'xorgate-google-roads-api-key-dev';
    engineTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EngineGoogleRoadsSecret',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${googleRoadsSecretName}*`,
        ],
      }),
    );
    // Anthropic API key for model.vlm (M5) — same out-of-band-secret pattern.
    const anthropicSecretName = isProd
      ? 'xorgate-anthropic-api-key'
      : 'xorgate-anthropic-api-key-dev';
    engineTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EngineAnthropicSecret',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${anthropicSecretName}*`,
        ],
      }),
    );
    // Optional platform-level HERE key (M7) — same out-of-band pattern; the
    // env var is wired below whether or not the secret exists yet.
    const hereSecretName = isProd ? 'xorgate-here-api-key' : 'xorgate-here-api-key-dev';
    engineTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EngineHereSecret',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${hereSecretName}*`,
        ],
      }),
    );
    // Per-org connector credentials (M7): the engine resolves
    // xorgate/orgs/<orgId>/<provider> ahead of the platform secrets. Read-only
    // name-pattern grant; the org-settings Lambda owns the writes (api-stack).
    engineTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EngineOrgCredentialSecrets',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:xorgate/orgs/*`,
        ],
      }),
    );

    this.engineTaskFamily = isProd ? 'xorgate-engine-runner' : 'xorgate-engine-runner-dev';
    this.engineTaskDefinition = new ecs.FargateTaskDefinition(this, 'EngineRunnerTaskDef', {
      family: this.engineTaskFamily,
      cpu: 2048, // 2 vCPU — ffmpeg decode + ONNX CPU inference (same as cv-runner)
      memoryLimitMiB: 4096,
      taskRole: engineTaskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    this.engineTaskDefinition.addContainer('engine-runner', {
      containerName: this.engineContainerName,
      image: ecs.ContainerImage.fromEcrRepository(this.engineRepository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'engine-runner', logGroup: engineLogGroup }),
      // Static env, deliberately NOT part of the frozen per-run RunTask
      // override contract (RUN_ID/MANIFEST_BUCKET/MANIFEST_KEY/AWS_REGION):
      // the secrets seam maps logical secret names through it.
      environment: {
        GOOGLE_ROADS_SECRET_NAME: googleRoadsSecretName,
        HERE_SECRET_NAME: hereSecretName,
        ANTHROPIC_SECRET_NAME: anthropicSecretName,
      },
      // The runner self-limits via manifest.limits.maxRuntimeSeconds and always
      // writes result.json on the way out; this is the hard ECS backstop.
      stopTimeout: cdk.Duration.seconds(120),
    });
    this.engineTaskRoleArn = engineTaskRole.roleArn;
    this.engineExecutionRoleArn = this.engineTaskDefinition.obtainExecutionRole().roleArn;

    // The SHARED Fargate cluster (engine-runner dispatch + the scheduler's
    // stale-task stop). Historic name; see the class doc.
    new cdk.CfnOutput(this, 'RecorderClusterArn', {
      value: this.cluster.clusterArn,
      exportName: `XorgateRecorderClusterArn${suffix}`,
    });
    new cdk.CfnOutput(this, 'EngineRunnerRepoUri', {
      value: this.engineRepository.repositoryUri,
      exportName: `XorgateEngineRunnerRepoUri${suffix}`,
    });
  }
}
