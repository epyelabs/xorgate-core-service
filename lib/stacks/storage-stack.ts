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

    if (isProd) {
      this.vpc = new ec2.Vpc(this, 'XorgateVpc', {
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration: [
          { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
          { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
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
          allowedOrigins: [
            'http://localhost:*',
            'https://xorgate.ai',
            'http://dev.xorgate.io.s3-website-us-east-1.amazonaws.com',
            'http://www.xorgate.io.s3-website-us-east-1.amazonaws.com',
            'https://d3u971sluio616.cloudfront.net',
            'https://dev.xorgate.io',
            'https://www.xorgate.io',
          ],
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
