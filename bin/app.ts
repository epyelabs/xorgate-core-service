import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { XorgateCoreStorageStack } from '../lib/stacks/storage-stack';
import { XorgateCoreDatabaseStack } from '../lib/stacks/database-stack';
import { XorgateCoreAuthStack } from '../lib/stacks/auth-stack';
import { XorgateCoreIotStack } from '../lib/stacks/iot-stack';
import { XorgateCoreApiStack } from '../lib/stacks/api-stack';
import { XorgateCoreRecorderStack } from '../lib/stacks/recorder-stack';

// Recorder props shared by both stages: launch/stop config the api-stack Lambdas
// need to run the Fargate viewer-recorder and pass its roles.
function recorderProps(rec: XorgateCoreRecorderStack) {
  return {
    recorderClusterArn: rec.cluster.clusterArn,
    recorderClusterName: rec.cluster.clusterName,
    recorderTaskFamily: rec.taskFamily,
    recorderTaskRoleArn: rec.taskRoleArn,
    recorderExecutionRoleArn: rec.executionRoleArn,
    recorderSecurityGroupId: rec.securityGroup.securityGroupId,
    recorderSubnets: rec.publicSubnetIds.join(','),
    recorderContainerName: rec.containerName,
    // CV runner (workflows video path) shares the recorder cluster/VPC/SG.
    cvTaskFamily: rec.cvTaskFamily,
    cvTaskRoleArn: rec.cvTaskRoleArn,
    cvExecutionRoleArn: rec.cvExecutionRoleArn,
    cvContainerName: rec.cvContainerName,
  };
}

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

// Cron jobs (OfflineSweeper) poll the shared sandbox Aurora via Data API and
// block its auto-pause (~$1.45/day). Default OFF in dev; override with
// --context scheduledJobs=on (or =off to force-disable).
const scheduledJobsCtx = app.node.tryGetContext('scheduledJobs') as
  | 'on'
  | 'off'
  | undefined;
const disableScheduledJobs =
  scheduledJobsCtx === 'on'
    ? false
    : scheduledJobsCtx === 'off'
      ? true
      : stage === 'dev';

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

  const recorderStack = new XorgateCoreRecorderStack(app, 'XorgateCoreRecorderStack', {
    env,
    stage,
    bucket: storageStack.bucket,
  });

  new XorgateCoreApiStack(app, 'XorgateCoreApiStack', {
    env,
    stage,
    vpc: storageStack.vpc,
    bucket: storageStack.bucket,
    distBucket: storageStack.distBucket,
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
    ...recorderProps(recorderStack),
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

  const recorderStack = new XorgateCoreRecorderStack(app, 'XorgateCoreRecorderStackDev', {
    env,
    stage,
    bucket: storageStack.bucket,
  });

  new XorgateCoreApiStack(app, 'XorgateCoreApiStackDev', {
    env,
    stage,
    disableScheduledJobs,
    bucket: storageStack.bucket,
    distBucket: storageStack.distBucket,
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
    ...recorderProps(recorderStack),
  });
}

app.synth();
