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

    new cdk.CfnOutput(this, 'RecorderClusterArn', {
      value: this.cluster.clusterArn,
      exportName: `XorgateRecorderClusterArn${suffix}`,
    });
    new cdk.CfnOutput(this, 'RecorderRepoUri', {
      value: this.repository.repositoryUri,
      exportName: `XorgateRecorderRepoUri${suffix}`,
    });
  }
}
