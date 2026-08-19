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
      // Matches the shared sandbox cluster (epye-sandbox-db) exactly: min 0 ACU
      // with a 30-minute auto-pause, max 4. A 0.5 ACU floor never pauses and
      // bills around $44/month for an idle cluster; 0 bills nothing while
      // nothing is connected, which is the right shape for an environment that
      // does not exist yet and will start empty.
      //
      // Safe here specifically because BOTH stages reach Postgres over the RDS
      // Data API (src/db/index.ts uses drizzle-orm/aws-data-api/pg), which
      // resumes a paused cluster transparently. A direct connection pool would
      // see errors on the first call after a pause instead. The cost is a cold
      // resume of a few seconds on the first request after idle, on top of the
      // Lambda cold start.
      //
      // Note it will only actually pause if nothing is connected. The dev
      // cluster never does, because live telemetry ingest writes every 30-45 s.
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 4,
      serverlessV2AutoPauseDuration: cdk.Duration.minutes(30),
      writer: rds.ClusterInstance.serverlessV2('writer'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      enableDataApi: true,
      defaultDatabaseName: 'xorgatedb',
      storageEncrypted: true,
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
