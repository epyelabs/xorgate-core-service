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
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 8,
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
