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
  // Core bucket; recordings are written under media/v1/<deviceId>/<streamKey>/.
  bucket: s3.Bucket;
}

/**
 * Cloud-side video recorder infra. A headless KVS WebRTC viewer-recorder runs as a
 * Fargate task: it joins a device's existing signaling channel as one more VIEWER,
 * remuxes the incoming H.264 to MP4, and uploads it to the core bucket on stop. The
 * device and the browser's live P2P viewing are untouched.
 *
 * The recorder image lives in this stack's ECR repo (built + pushed out-of-band
 * from xorgate/device/xorgate-kvs-webrtc). The api-stack's Lambdas launch/stop
 * tasks here (RunTask/StopTask) using the exported ARNs.
 *
 * Networking: a dedicated public-subnet VPC with NO NAT gateway (tasks get a public
 * IP and reach KVS/S3/TURN directly) keeps cost down for the PoC.
 */
export class XorgateCoreRecorderStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly repository: ecr.Repository;
  public readonly containerName = 'recorder';
  public readonly taskFamily: string;
  public readonly taskRoleArn: string;
  public readonly executionRoleArn: string;
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

    // Public-only VPC, no NAT (tasks use a public IP to reach KVS/S3/TURN).
    const vpc = new ec2.Vpc(this, 'RecorderVpc', {
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

    this.repository = new ecr.Repository(this, 'RecorderRepo', {
      repositoryName: isProd ? 'xorgate-recorder' : 'xorgate-recorder-dev',
      removalPolicy,
      emptyOnDelete: !isProd,
      imageScanOnPush: true,
    });

    this.cluster = new ecs.Cluster(this, 'RecorderCluster', {
      clusterName: isProd ? 'xorgate-recorder' : 'xorgate-recorder-dev',
      vpc,
    });

    const logGroup = new logs.LogGroup(this, 'RecorderLogs', {
      logGroupName: isProd ? '/xorgate/recorder' : '/xorgate/recorder-dev',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy,
    });

    // Task role: KVS viewer + S3 upload (scoped to the media prefix, mirroring the
    // device credential role's media/v1/* grant in iot-stack.ts).
    const taskRole = new iam.Role(this, 'RecorderTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Xorgate recorder task: KVS viewer + media S3 upload',
    });
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'KvsViewer',
        actions: [
          'kinesisvideo:DescribeSignalingChannel',
          'kinesisvideo:GetSignalingChannelEndpoint',
          'kinesisvideo:GetIceServerConfig',
          'kinesisvideo:ConnectAsViewer',
        ],
        resources: [`arn:aws:kinesisvideo:${this.region}:${this.account}:channel/*`],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'MediaS3Upload',
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('media/v1/*')],
      }),
    );
    // On its first received frame the recorder publishes a "capturing" event to
    // IoT Core (xorgate/recordings/<recordingId>/status), which a topic rule turns
    // into recordings.capture_started_at. Scoped to the recordings topic space.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'IotPublishStatus',
        actions: ['iot:Publish'],
        resources: [`arn:aws:iot:${this.region}:${this.account}:topic/xorgate/recordings/*`],
      }),
    );
    // The bundled aws-cli v1 defaults iot-data to the deprecated non-ATS endpoint
    // (data.iot.<region>), whose cert is no longer trusted. entrypoint.sh resolves the
    // account's ATS data endpoint at startup so the publish can target it explicitly.
    // DescribeEndpoint does not support resource-level permissions.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'IotDescribeEndpoint',
        actions: ['iot:DescribeEndpoint'],
        resources: ['*'],
      }),
    );

    this.taskFamily = isProd ? 'xorgate-recorder' : 'xorgate-recorder-dev';
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'RecorderTaskDef', {
      family: this.taskFamily,
      cpu: 512, // 0.5 vCPU — video-only remux, no re-encode
      memoryLimitMiB: 1024,
      taskRole,
      runtimePlatform: {
        // ARM64 (Graviton): cheaper, and builds natively/fast on the arm64 dev
        // machine. The recorder image must be built for linux/arm64 to match.
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    this.taskDefinition.addContainer('recorder', {
      containerName: this.containerName,
      image: ecs.ContainerImage.fromEcrRepository(this.repository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'recorder', logGroup }),
      // ECS sends SIGTERM then SIGKILL after this window; the recorder needs time
      // to flush a clean MP4 (EOS -> moov atom) and upload before being killed.
      stopTimeout: cdk.Duration.seconds(120),
    });

    // Exposed for the api-stack's Lambdas (RunTask env + iam:PassRole grant).
    this.taskRoleArn = taskRole.roleArn;
    this.executionRoleArn = this.taskDefinition.obtainExecutionRole().roleArn;
    this.publicSubnetIds = vpc.publicSubnets.map((s) => s.subnetId);

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

    // Task role: read inputs (recordings, v2 manifests, the model registry),
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
          bucket.arnForObjects('media/v1/*'),
          bucket.arnForObjects('workflows/v2/*'),
          bucket.arnForObjects('models/*'),
        ],
      }),
    );
    engineTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EngineListModelRegistry',
        actions: ['s3:ListBucket'],
        resources: [bucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': 'models/*' } },
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

    new cdk.CfnOutput(this, 'RecorderClusterArn', {
      value: this.cluster.clusterArn,
      exportName: `XorgateRecorderClusterArn${suffix}`,
    });
    new cdk.CfnOutput(this, 'RecorderRepoUri', {
      value: this.repository.repositoryUri,
      exportName: `XorgateRecorderRepoUri${suffix}`,
    });
    new cdk.CfnOutput(this, 'EngineRunnerRepoUri', {
      value: this.engineRepository.repositoryUri,
      exportName: `XorgateEngineRunnerRepoUri${suffix}`,
    });
  }
}
