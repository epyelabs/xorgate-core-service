import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { XorgateCoreStorageStack } from '../lib/stacks/storage-stack';
import { XorgateCoreDatabaseStack } from '../lib/stacks/database-stack';
import { XorgateCoreAuthStack } from '../lib/stacks/auth-stack';
import { XorgateCoreIotStack } from '../lib/stacks/iot-stack';
import { XorgateCoreApiStack } from '../lib/stacks/api-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const stage = app.node.tryGetContext('stage') as 'dev' | 'prod' | undefined;
if (stage !== 'dev' && stage !== 'prod') {
  throw new Error(
    "Missing stage. Pass --context stage=dev or --context stage=prod " +
    "(use 'npm run deploy:dev' or 'npm run deploy:prod').",
  );
}

if (stage === 'prod') {
  const storageStack = new XorgateCoreStorageStack(app, 'XorgateCoreStorageStack', { env, stage });

  const databaseStack = new XorgateCoreDatabaseStack(app, 'XorgateCoreDatabaseStack', {
    env,
    vpc: storageStack.vpc!,
  });

  const authStack = new XorgateCoreAuthStack(app, 'XorgateCoreAuthStack', { env, stage });

  const iotStack = new XorgateCoreIotStack(app, 'XorgateCoreIotStack', {
    env,
    stage,
    bucket: storageStack.bucket,
    userPool: authStack.userPool,
    userPoolClient: authStack.userPoolClient,
  });

  new XorgateCoreApiStack(app, 'XorgateCoreApiStack', {
    env,
    stage,
    vpc: storageStack.vpc,
    bucket: storageStack.bucket,
    dbCluster: databaseStack.cluster,
    dbSecret: databaseStack.dbSecret,
    dbSecurityGroup: databaseStack.dbSecurityGroup,
    dbName: 'xorgatedb',
    userPoolId: authStack.userPool.userPoolId,
    userPoolClientId: authStack.userPoolClient.userPoolClientId,
    iotThingTypeName: iotStack.thingTypeName,
    iotPolicyName: iotStack.iotPolicyName,
    browserIotPolicyName: iotStack.browserPolicyName,
    iotRoleAlias: iotStack.roleAliasName,
    cognitoIdentityPoolId: iotStack.identityPoolId,
    cognitoUserPoolProvider: iotStack.userPoolProviderName,
  });
} else {
  // Dev: no dedicated DB cluster, no VPC. Imports the shared sandbox Aurora
  // cluster (epyelabs/epye-sandbox-stack) and reaches it via RDS Data API.
  const storageStack = new XorgateCoreStorageStack(app, 'XorgateCoreStorageStackDev', { env, stage });
  const authStack = new XorgateCoreAuthStack(app, 'XorgateCoreAuthStackDev', { env, stage });

  const iotStack = new XorgateCoreIotStack(app, 'XorgateCoreIotStackDev', {
    env,
    stage,
    bucket: storageStack.bucket,
    userPool: authStack.userPool,
    userPoolClient: authStack.userPoolClient,
  });

  new XorgateCoreApiStack(app, 'XorgateCoreApiStackDev', {
    env,
    stage,
    bucket: storageStack.bucket,
    dbClusterArn: cdk.Fn.importValue('EpyeSandboxClusterArn'),
    dbSecretName: 'epye-sandbox/xorgate-db-credentials',
    dbName: 'xorgatedb_dev',
    userPoolId: authStack.userPool.userPoolId,
    userPoolClientId: authStack.userPoolClient.userPoolClientId,
    iotThingTypeName: iotStack.thingTypeName,
    iotPolicyName: iotStack.iotPolicyName,
    browserIotPolicyName: iotStack.browserPolicyName,
    iotRoleAlias: iotStack.roleAliasName,
    cognitoIdentityPoolId: iotStack.identityPoolId,
    cognitoUserPoolProvider: iotStack.userPoolProviderName,
  });
}

app.synth();
