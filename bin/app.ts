import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { XorgateCoreStorageStack } from '../lib/stacks/storage-stack';
import { XorgateCoreDatabaseStack } from '../lib/stacks/database-stack';
import { XorgateCoreAuthStack } from '../lib/stacks/auth-stack';
import { XorgateCoreIotStack } from '../lib/stacks/iot-stack';
import { XorgateCoreApiStack } from '../lib/stacks/api-stack';
import { XorgateCoreRecorderStack } from '../lib/stacks/recorder-stack';

// Shared Fargate props for both stages: the cluster/network the api-stack
// Lambdas launch engine-runner tasks into. The `recorder*` names are historic
// (destroy-kvs-recorder Phase 5 removed the cloud recorder; its four task-only
// props went with it) — renaming them is deliberately out of scope.
function recorderProps(rec: XorgateCoreRecorderStack) {
  return {
    recorderClusterArn: rec.cluster.clusterArn,
    recorderClusterName: rec.cluster.clusterName,
    recorderSecurityGroupId: rec.securityGroup.securityGroupId,
    recorderSubnets: rec.publicSubnetIds.join(','),
    // v2 engine runner (the only workflow execution plane since M6; the CV
    // runner props were retired with the Python cv-runner).
    engineTaskFamily: rec.engineTaskFamily,
    engineTaskRoleArn: rec.engineTaskRoleArn,
    engineExecutionRoleArn: rec.engineExecutionRoleArn,
    engineContainerName: rec.engineContainerName,
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

// Telemetry retention (improve-recording-history-fetching plan, phase 4).
// SHIPS DORMANT AND STAYS DORMANT until someone opts in on the command line:
//   npm run deploy:dev -- --context telemetryRetention=on
//   [--context telemetryRetentionDays=180]
// Deliberately NOT folded into scheduledJobs: dev wants the monthly maintenance
// schedule on so future month partitions exist, and that must never imply
// "start deleting history". There is no environment in which this defaults on;
// the 90-day fallback window is a placeholder pending real production data
// (plan Q4), and src/services/telemetry-partitions.ts refuses windows under 31
// days and caps drops per run regardless.
const telemetryRetention = app.node.tryGetContext('telemetryRetention') === 'on';
const retentionDaysCtx = Number(app.node.tryGetContext('telemetryRetentionDays'));
const telemetryRetentionDays =
  Number.isFinite(retentionDaysCtx) && retentionDaysCtx > 0 ? retentionDaysCtx : undefined;

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
    telemetryRetention,
    telemetryRetentionDays,
    // NO `vpc` and NO `dbSecurityGroup`, deliberately, which puts the prod
    // Lambdas on exactly the same footing as dev's: not VPC-attached, reaching
    // Postgres over the RDS Data API (src/db/index.ts speaks nothing else).
    // Passing `vpc` here is what would attach every DB-touching Lambda to a
    // PRIVATE_WITH_EGRESS subnet, which is what would require a NAT gateway,
    // and it would add the VPC cold-start penalty on top. The cluster still
    // lives in the VPC's isolated subnets; only the Lambdas stay out.
    //
    // Reversing this is a one-line change plus a NAT gateway. It does not touch
    // the database.
    bucket: storageStack.bucket,
    distBucket: storageStack.distBucket,
    dbCluster: databaseStack.cluster,
    dbSecret: databaseStack.dbSecret,
    dbName: 'xorgatedb',
    userPoolId: authStack.userPool.userPoolId,
    userPoolClientId: authStack.userPoolClient.userPoolClientId,
    iotThingTypeName: iotStack.thingTypeName,
    iotPolicyName: iotStack.iotPolicyName,
    browserIotPolicyName: iotStack.browserPolicyName,
    iotRoleAlias: iotStack.roleAliasName,
    cognitoIdentityPoolId: iotStack.identityPoolId,
    cognitoUserPoolProvider: iotStack.userPoolProviderName,
    liveVendRoleArn: iotStack.liveVendRoleArn,
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
    telemetryRetention,
    telemetryRetentionDays,
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
    liveVendRoleArn: iotStack.liveVendRoleArn,
    ...recorderProps(recorderStack),
  });
}

app.synth();
