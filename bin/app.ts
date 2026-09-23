import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { XorgateCoreStorageStack } from '../lib/stacks/storage-stack';
import { XorgateCoreDatabaseStack } from '../lib/stacks/database-stack';
import { XorgateCoreAuthStack } from '../lib/stacks/auth-stack';
import { XorgateCoreIotStack } from '../lib/stacks/iot-stack';
import { XorgateCoreApiStack } from '../lib/stacks/api-stack';
import { XorgateCoreRecorderStack } from '../lib/stacks/recorder-stack';
import { XorgateCoreEmailStack } from '../lib/stacks/email-stack';

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
// DEFAULT OFF IN DEV, ON IN PROD (since 2026-09-22; see below). Dev has always been off for the
// cost reason. Prod joined it because prod was created empty, on a cluster
// deliberately configured with a 0-ACU floor and a 30-minute auto-pause: a
// one-minute poller with no devices and no workflows to act on would have
// billed a full always-on cluster to do nothing, which is exactly what the
// 0-ACU floor was chosen to avoid.
//
// PROD DEFAULT FLIPPED TO ON 2026-09-22 (owner decision, telemetry-session-
// artifacts plan, Phase 2). Prod carries real devices and the artifact design
// depends on the sweeper: it closes sessions and builds each telemetry
// session's overview + insights, expires index rows, sweeps devices offline
// and fires scheduled workflows. With it off none of that happens on its own
// (prod ran that way from 2026-08-19 to 2026-09-22: zero scheduled sweeper
// invocations, sessions closed only on read). The cost is an always-awake
// prod cluster, roughly $44/month at the 0.5 ACU it idles at.
//
// Dev stays off (shared sandbox, auto-pause). Either stage can be overridden
// per deploy:
//
//   npm run deploy:dev  -- --context scheduledJobs=on
//   npm run deploy:prod -- --context scheduledJobs=off
const scheduledJobsCtx = app.node.tryGetContext('scheduledJobs') as
  | 'on'
  | 'off'
  | undefined;
const disableScheduledJobs =
  scheduledJobsCtx === 'on' ? false : scheduledJobsCtx === 'off' ? true : stage !== 'prod';

// Telemetry retention: the `telemetry_readings` HOT WINDOW (90 days, owner
// decision Q1 of plans/telemetry-session-artifacts, 2026-09-22). Recorded
// telemetry's system of record is the S3 artifacts under `telemetry/v1/`
// (kept 365 d, storage-stack); the Postgres rows are a derived copy that
// partition-maintenance drops a month at a time once every row in the month
// is older than the window (src/services/telemetry-partitions.ts).
//
// DEFAULT PER STAGE. Dev ON since Phase 5 (2026-09-23). Prod stays OFF here
// until the OWNER flips `prod: true` below and runs `npm run deploy:prod`;
// that is the one prod switch of the phase and is deliberately a code change,
// not a `--context` flag, so a later plain deploy cannot silently turn it back
// off (the scheduledJobs lesson of 2026-09-22). Before flipping it, confirm
// prod's index is complete (PROGRESS.md P5 entry has the verification query).
//
// Still deliberately NOT folded into scheduledJobs: the maintenance schedule
// exists so future month partitions get created, and that must never imply
// "start deleting history". Per-deploy override either way:
//   npm run deploy:dev  -- --context telemetryRetention=off
//   npm run deploy:prod -- --context telemetryRetention=on [--context telemetryRetentionDays=90]
// The planner refuses windows under 31 days and caps drops per run regardless,
// and the handler holds back a month whose telemetry sessions have no
// overview artifact yet (handlers/partition-maintenance.ts).
const TELEMETRY_RETENTION_DEFAULT: Record<'dev' | 'prod', boolean> = {
  dev: true,
  prod: false, // OWNER: flip to true to enable the 90-day hot window on prod.
};
const telemetryRetentionCtx = app.node.tryGetContext('telemetryRetention') as 'on' | 'off' | undefined;
const telemetryRetention =
  telemetryRetentionCtx === 'on'
    ? true
    : telemetryRetentionCtx === 'off'
      ? false
      : TELEMETRY_RETENTION_DEFAULT[stage];
const retentionDaysCtx = Number(app.node.tryGetContext('telemetryRetentionDays'));
const telemetryRetentionDays =
  Number.isFinite(retentionDaysCtx) && retentionDaysCtx > 0 ? retentionDaysCtx : undefined;
// The READERS' boundary (services/telemetry-window.ts): a workflow window older
// than this reads the S3 artifacts. Defaults to the retention window; narrow it
// per deploy with `--context telemetryHotWindowDays=<n>` (S3 is the record, so
// a narrower boundary is always safe).
const hotWindowCtx = Number(app.node.tryGetContext('telemetryHotWindowDays'));
const telemetryHotWindowDays =
  Number.isFinite(hotWindowCtx) && hotWindowCtx > 0 ? hotWindowCtx : undefined;

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
// The deployed console origin for this stage: where links inside emails point.
const appUrl = stage === 'prod' ? 'https://console.xorgate.io' : 'https://dev.xorgate.io';

// Outbound email (SES). Prod sends as xorgate.io; dev as dev.xorgate.io, so
// the shared Epye sandbox account can never sign mail as production. The user
// pool keeps Cognito's default sender until BOTH the domain's DNS records
// resolve AND the SES account is out of the sandbox, then the stage's flag in
// cdk.json (`cognitoEmailViaSes`) is flipped to true — or, for one deploy:
//   npm run deploy:prod -- --context cognitoEmailViaSes=true
// Flipping it early breaks every signup / invite / reset email, so the flag is
// per stage and defaults off for a stage that has not been cut over.
const EMAIL_DOMAINS: Record<typeof stage, string> = {
  dev: 'dev.xorgate.io',
  prod: 'xorgate.io',
};
const sesCtx = app.node.tryGetContext('cognitoEmailViaSes') as
  | Record<string, boolean>
  | string
  | boolean
  | undefined;
const cognitoEmailViaSes =
  typeof sesCtx === 'object' && sesCtx !== null
    ? Boolean(sesCtx[stage])
    : sesCtx === true || sesCtx === 'true';

const suffix = stage === 'prod' ? '' : 'Dev';

const emailStack = new XorgateCoreEmailStack(app, `XorgateCoreEmailStack${suffix}`, {
  env,
  stage,
  domain: EMAIL_DOMAINS[stage],
});

const authProps = {
  googleClientId,
  hostedUiDomainPrefix,
  webAppUrls,
  appUrl,
  sesEmail: cognitoEmailViaSes
    ? {
        fromAddress: emailStack.fromAddress,
        fromName: emailStack.fromName,
        domain: emailStack.domain,
        configurationSetName: emailStack.configurationSet.configurationSetName,
      }
    : undefined,
};

const emailProps = {
  appUrl,
  email: {
    from: `${emailStack.fromName} <${emailStack.fromAddress}>`,
    identityArn: emailStack.identity.emailIdentityArn,
    configurationSetName: emailStack.configurationSet.configurationSetName,
    // The ConfigurationSet construct exposes no ARN attribute; SES
    // configuration-set ARNs are deterministic from the name.
    configurationSetArn: `arn:aws:ses:${env.region}:${env.account}:configuration-set/${emailStack.configurationSet.configurationSetName}`,
  },
};

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
  if (cognitoEmailViaSes) authStack.addDependency(emailStack);

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
    telemetryHotWindowDays,
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
    ...emailProps,
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
  if (cognitoEmailViaSes) authStack.addDependency(emailStack);

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
    telemetryHotWindowDays,
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
    ...emailProps,
  });
}

app.synth();
