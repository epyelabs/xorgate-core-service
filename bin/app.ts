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

const stage = app.node.tryGetContext('stage') as 'dev' | 'prod' | undefined;
if (stage !== 'dev' && stage !== 'prod') {
  throw new Error(
    "Missing stage. Pass --context stage=dev or --context stage=prod " +
    "(use 'npm run deploy:dev' or 'npm run deploy:prod').",
  );
}

// The account is PINNED PER STAGE rather than taken from CDK_DEFAULT_ACCOUNT.
//
// It used to come from whichever credentials happened to be active, while the
// stage came from a separate --context flag, and nothing tied the two together.
// `npm run deploy:prod` with a dev profile would therefore deploy production
// stacks into the development account AND SUCCEED. With the account pinned, CDK
// refuses on a mismatch instead of quietly doing the wrong thing in the wrong
// place.
//
// Dev is the shared Epye Labs playground; prod has its own account, as of
// 2026-08-21 (plans/aws-organization-and-account-split Phase 4). Each product's
// production environment gets an account of its own under the one Organization,
// which is what makes the bill attribute itself with no tagging discipline.
const ACCOUNTS: Record<'dev' | 'prod', string> = {
  dev: '111910761410',
  prod: '865609249890',
};

const env: cdk.Environment = {
  account: ACCOUNTS[stage],
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// Cron jobs poll Aurora via the Data API every minute (OfflineSweeper and
// WorkflowScheduler both run at `rate(1 minute)`), which keeps the cluster
// awake and stops it auto-pausing. On the shared sandbox that costs ~$1.45/day.
//
// DEFAULT OFF IN BOTH STAGES as of 2026-08-19. Dev has always been off for the
// cost reason. Prod joined it because prod was created empty, on a cluster
// deliberately configured with a 0-ACU floor and a 30-minute auto-pause: a
// one-minute poller with no devices and no workflows to act on would have
// billed a full always-on cluster to do nothing, which is exactly what the
// 0-ACU floor was chosen to avoid.
//
// >>> TURN THIS ON FOR PROD BEFORE PROD CARRIES ANYTHING. <<<
// With it off, devices are never marked offline and scheduled workflows never
// fire. The trigger is the first real device or the first workflow schedule in
// production, not a date:
//
//   npm run deploy:prod -- --context scheduledJobs=on
//
// (or flip the default below, which is better once prod is permanently live).
const scheduledJobsCtx = app.node.tryGetContext('scheduledJobs') as
  | 'on'
  | 'off'
  | undefined;
const disableScheduledJobs =
  scheduledJobsCtx === 'on' ? false : scheduledJobsCtx === 'off' ? true : true;

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

// Google Hosted-UI federation ("Continue with Google" in xorgate-web). When
// googleClientId resolves to nothing the auth stack stays Cognito-only. The
// client secret is read from Secrets Manager `xorgate/oauth-providers[-dev]`
// (JSON key `googleClientSecret`); both exist as of 2026-08-28.
//   npm run deploy:dev -- [--context googleClientId=<id>|off]
//   [--context webAppUrls=http://localhost:5173,https://dev.xorgate.io]
//   [--context hostedUiDomainPrefix=xorgate-authdev]
// The Google client itself must list
// https://<prefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse as an
// authorized redirect URI.
// Client IDs are public identifiers (the secret is the Secrets Manager entry).
// Baked in per stage so a plain `deploy:dev` / `deploy:prod` keeps federation
// on; `--context googleClientId=off` turns it off for one deploy.
const GOOGLE_CLIENT_IDS: Record<typeof stage, string> = {
  dev: '905531180123-etp9el5cm67kvsa2ugdma085ernfjj3n.apps.googleusercontent.com',
  prod: '905531180123-f9ieep01amtiijakkkvml873ehcloi2s.apps.googleusercontent.com',
};
const googleClientIdCtx = app.node.tryGetContext('googleClientId') as string | undefined;
const googleClientId =
  googleClientIdCtx === 'off' ? undefined : (googleClientIdCtx ?? GOOGLE_CLIENT_IDS[stage]);
const hostedUiDomainPrefix = app.node.tryGetContext('hostedUiDomainPrefix') as
  | string
  | undefined;
const webAppUrlsCtx = app.node.tryGetContext('webAppUrls') as string | undefined;
const webAppUrls = webAppUrlsCtx
  ? webAppUrlsCtx
      .split(',')
      .map((u) => u.trim().replace(/\/+$/, ''))
      .filter(Boolean)
  : stage === 'prod'
    ? ['https://console.xorgate.io']
    : ['http://localhost:5173', 'https://dev.xorgate.io'];
const authProps = { googleClientId, hostedUiDomainPrefix, webAppUrls };

if (stage === 'prod') {
  const storageStack = new XorgateCoreStorageStack(app, 'XorgateCoreStorageStack', { env, stage });

  const databaseStack = new XorgateCoreDatabaseStack(app, 'XorgateCoreDatabaseStack', {
    env,
    vpc: storageStack.vpc!,
  });

  const authStack = new XorgateCoreAuthStack(app, 'XorgateCoreAuthStack', {
    env,
    stage,
    ...authProps,
  });

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
    // Share the storage stack's VPC rather than building a second one for the
    // same environment. Its public subnets are what Fargate needs, and the
    // account is at the default 5-VPC-per-region limit.
    vpc: storageStack.vpc,
  });

  new XorgateCoreApiStack(app, 'XorgateCoreApiStack', {
    env,
    stage,
    // Prod did not pass this at all until 2026-08-19, so the schedules were
    // silently enabled there while dev disabled them. See the note above.
    disableScheduledJobs,
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
  const authStack = new XorgateCoreAuthStack(app, 'XorgateCoreAuthStackDev', {
    env,
    stage,
    ...authProps,
  });

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
