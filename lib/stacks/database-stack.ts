import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface XorgateCoreDatabaseStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

export class XorgateCoreDatabaseStack extends cdk.Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly dbSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: XorgateCoreDatabaseStackProps) {
    super(scope, id, props);

    const { vpc } = props;

    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSG', {
      vpc,
      description: 'Aurora PostgreSQL security group - ingress from Lambda SG only',
      allowAllOutbound: false,
    });

    const credentials = rds.Credentials.fromGeneratedSecret('xorgate_admin', {
      secretName: 'xorgate/db-credentials',
      excludeCharacters: '"@/\\',
    });

    this.cluster = new rds.DatabaseCluster(this, 'XorgateAurora', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_17_5,
      }),
      credentials,
      // min 0.5 / max 4 ACU since 2026-10-04, so the cluster never auto-pauses.
      // It began at min 0 with a 30-minute auto-pause (the epye-sandbox shape,
      // right for an environment that started empty), but by then telemetry
      // ingest kept it awake anyway: 14 days averaged ~0.87 ACU and never
      // dropped below 0.5, so the floor costs nothing today. What it buys is
      // the quiet-fleet case — every device offline for 30 min would pause the
      // cluster, and a resume can outlast the 20 s Lambda timeout (alocate prod,
      // which calls this API, saw exactly that). Worst case is ~$44/month idle.
      //
      // Max 4 is ample: the 4 ACU touches are single-minute bursts with read
      // latency < 16 ms; hourly averages stay 0.5-1.5. Raise it only if
      // ACUUtilization pins at 100% for minutes while latency climbs.
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
      writer: rds.ClusterInstance.serverlessV2('writer'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      enableDataApi: true,
      defaultDatabaseName: 'xorgatedb',
      storageEncrypted: true,
      // ON as of 2026-08-22. It was OFF for the first production bring-up,
      // deliberately, with the recorded trigger to flip it being "the first real
      // organization in prod". The `Alocate` organization is that trigger: prod
      // is now the environment an external consumer is pointed at, so the
      // ability to tear it down and redo it is no longer worth more than the
      // protection.
      //
      // This stack is created for the `prod` stage only (see bin/app.ts), so
      // nothing about dev changes. Dev reaches the shared epye-sandbox cluster,
      // which this file does not own.
      //
      // `removalPolicy: RETAIN` is unchanged and still means `cdk destroy` will
      // not delete the cluster. The two guards stack rather than overlap:
      // RETAIN stops CDK, and deletionProtection now also stops a direct
      // `delete-db-cluster`, which previously only needed one console click.
      // Deleting the cluster now requires deliberately turning this off first.
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.dbSecret = this.cluster.secret!;

    new cdk.CfnOutput(this, 'ClusterArn', {
      value: this.cluster.clusterArn,
      exportName: 'XorgateCoreDbClusterArn',
    });

    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: this.dbSecret.secretArn,
      exportName: 'XorgateCoreDbSecretArn',
    });
  }
}
