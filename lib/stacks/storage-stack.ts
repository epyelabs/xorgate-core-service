import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface XorgateCoreStorageStackProps extends cdk.StackProps {
  stage: 'dev' | 'prod';
}

export class XorgateCoreStorageStack extends cdk.Stack {
  public readonly vpc?: ec2.Vpc;
  public readonly bucket: s3.Bucket;
  // Public-read bucket holding the device-agent tarballs. Devices download the
  // build during `install.sh` with no AWS credentials, so the objects must be
  // anonymously readable (the registration code, not S3 auth, gates access).
  public readonly distBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: XorgateCoreStorageStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const isProd = stage === 'prod';
    const suffix = isProd ? '' : 'Dev';

    // Retention for device-recorded segment objects (offline recording plan,
    // Phase 6.3). One knob for both prefixes; keep in sync with the DB row
    // expiry the sweeper runs (api-stack SEGMENT_RETENTION_DAYS reads the same
    // context key). 90 d default for both stages until a prod policy is set.
    const retentionCtx = this.node.tryGetContext('segmentRetentionDays');
    const segmentRetentionDays =
      retentionCtx === undefined || retentionCtx === null ? 90 : Number(retentionCtx);

    if (isProd) {
      // NO NAT GATEWAY, and no PRIVATE_WITH_EGRESS subnets that would need one.
      //
      // This VPC exists for ONE reason: RDS requires a VPC, and a cluster's VPC
      // can never be changed after creation, so it has to be right on day one.
      // Aurora lives in the ISOLATED subnets, which by definition route nowhere
      // and have never needed a NAT.
      //
      // Nothing else in prod needs private egress either. The API Lambdas are
      // deliberately NOT attached to this VPC (see bin/app.ts): they reach
      // Postgres over the RDS Data API, exactly as dev does, and every other
      // dependency (S3, IoT, KVS, Secrets Manager, STS, ECS) is a public AWS
      // endpoint. Fargate tasks run in the recorder stack's own public-only VPC
      // with a public IP, which is the same trick this is.
      //
      // A NAT gateway is roughly $33/month plus data processing to buy egress
      // nothing currently wants. Adding one later is PURELY ADDITIVE — a NAT
      // gateway, a PRIVATE_WITH_EGRESS subnet group and a route table — and it
      // does not touch the database, because isolated subnets do not route
      // through it either way.
      this.vpc = new ec2.Vpc(this, 'XorgateVpc', {
        maxAzs: 2,
        natGateways: 0,
        subnetConfiguration: [
          { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
          { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
        ],
      });
    }

    this.bucket = new s3.Bucket(this, 'CoreBucket', {
      bucketName: isProd
        ? `xorgate-core-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`
        : `xorgate-core-dev-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [
        {
          // Every origin, for the same reason the API answers every origin.
          // The long form is above the CORS block in `lib/stacks/api-stack.ts`;
          // the part specific to this bucket:
          //
          // Nothing here is reachable without a signature. `BlockPublicAccess`
          // is BLOCK_ALL and `enforceSSL` is on, so an unsigned request is
          // refused whatever origin it claims. What a browser actually holds is
          // a PRESIGNED url, which carries its own authority and its own expiry
          // in the query string, and anything holding one can spend it from a
          // server where CORS does not apply. So an origin list here refuses
          // honest callers and stops no attacker.
          //
          // It was refusing honest callers. Three handlers hand a browser a
          // presigned url on a consumer-reachable gate (`device-sessions.ts`
          // for recorded video segments, `workflow-runs.ts` and
          // `workflow-simulations.ts` for run artifacts, all
          // `requireOrgContext` or `requireOrgWideContext`, so an API key or a
          // session token reaches all three). Before this, a third-party
          // application could fetch a url from the API and then be refused by
          // this bucket when its browser tried to use it: a 200 followed by a
          // CORS failure, which is the least debuggable pair in the platform.
          //
          // Same guard as the API: do not add a credentialed mode here. Phase 5
          // of plans/platform-auth-and-live-plane, 2026-08-18.
          allowedOrigins: ['*'],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          // Simulator input uploads (video/CSV via presigned POST) are
          // transient: the manifest snapshots what ran, and re-simulating
          // re-uploads. 7 days covers a demo/editing cycle.
          id: 'ExpireWorkflowUploads',
          prefix: 'workflows/v2/uploads/',
          expiration: cdk.Duration.days(7),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
        // Device-recorded segment prefixes (offline recording plan, Phase 6.3):
        // without expiry these grow without bound (~1.7 GB/h per recording
        // device). Age is a context value shared with the sweeper's DB row
        // expiry (SEGMENT_RETENTION_DAYS in api-stack) — override at deploy
        // with `--context segmentRetentionDays=<n>`. telemetry_readings rows
        // (the authoritative telemetry record) deliberately do NOT follow this
        // clock — only the raw .jsonl.gz upload artifacts and the video
        // segment objects expire.
        {
          id: 'ExpireTelemetrySegmentUploads',
          prefix: 'telemetry/v1/',
          expiration: cdk.Duration.days(segmentRetentionDays),
        },
        {
          id: 'ExpireMediaSessionSegments',
          prefix: 'media-sessions/v1/',
          expiration: cdk.Duration.days(segmentRetentionDays),
        },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // Emit S3 events to EventBridge so the api-stack can react to recorder uploads
    // (media/v1/*.mp4) via a rule, without a cross-stack notification dependency
    // cycle (bucket here, finalize Lambda in the api-stack).
    this.bucket.enableEventBridgeNotification();

    this.distBucket = new s3.Bucket(this, 'DeviceDistBucket', {
      bucketName: isProd
        ? `xorgate-device-dist-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`
        : `xorgate-device-dist-dev-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      versioned: isProd,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Anonymous GET on objects; everything else still blocked.
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      publicReadAccess: true,
      enforceSSL: true,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    if (this.vpc) {
      new cdk.CfnOutput(this, 'VpcId', {
        value: this.vpc.vpcId,
        exportName: `XorgateCoreVpcId${suffix}`,
      });
    }

    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      exportName: `XorgateCoreBucketName${suffix}`,
    });

    // Read by the device-deploy GitHub Actions workflows (resolve the bucket
    // name from the stack output to avoid drift with the CDK-generated name).
    new cdk.CfnOutput(this, 'DeviceDistBucketName', {
      value: this.distBucket.bucketName,
      exportName: `XorgateDeviceDistBucketName${suffix}`,
    });
    new cdk.CfnOutput(this, 'DeviceDistBucketUrl', {
      value: `https://${this.distBucket.bucketRegionalDomainName}`,
      exportName: `XorgateDeviceDistBucketUrl${suffix}`,
    });
  }
}
