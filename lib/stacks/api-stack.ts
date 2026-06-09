import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2int from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iot from "aws-cdk-lib/aws-iot";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import * as path from "path";

export interface XorgateCoreApiStackProps extends cdk.StackProps {
  stage: "dev" | "prod";
  bucket: s3.Bucket;
  dbCluster?: rds.DatabaseCluster;
  dbClusterArn?: string;
  dbSecret?: secretsmanager.ISecret;
  dbSecretName?: string;
  dbSecurityGroup?: ec2.SecurityGroup;
  dbName: string;
  vpc?: ec2.Vpc;
  userPoolId: string;
  userPoolClientId: string;
  iotThingTypeName: string;
  iotPolicyName: string;
  browserIotPolicyName: string;
  iotRoleAlias: string;
  cognitoIdentityPoolId: string;
  cognitoUserPoolProvider: string;
}

export class XorgateCoreApiStack extends cdk.Stack {
  public readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: XorgateCoreApiStackProps) {
    super(scope, id, props);

    const {
      stage,
      vpc,
      bucket,
      dbCluster,
      dbClusterArn: dbClusterArnProp,
      dbSecret: dbSecretProp,
      dbSecretName,
      dbSecurityGroup,
      dbName,
      userPoolId,
      userPoolClientId,
      iotThingTypeName,
      iotPolicyName,
      browserIotPolicyName,
      iotRoleAlias,
      cognitoIdentityPoolId,
      cognitoUserPoolProvider,
    } = props;

    const isProd = stage === "prod";
    const exportSuffix = isProd ? "" : "Dev";

    const clusterArn = dbCluster?.clusterArn ?? dbClusterArnProp;
    if (!clusterArn) {
      throw new Error(
        "XorgateCoreApiStack: dbCluster or dbClusterArn must be set",
      );
    }

    const dbSecret: secretsmanager.ISecret =
      dbSecretProp ??
      (dbSecretName
        ? secretsmanager.Secret.fromSecretNameV2(
            this,
            "DbSecretLookup",
            dbSecretName,
          )
        : (() => {
            throw new Error(
              "XorgateCoreApiStack: dbSecret or dbSecretName must be set",
            );
          })());

    const allowedOrigins: string[] = [
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
      "https://xorgate.ai",
    ];

    let lambdaSG: ec2.SecurityGroup | undefined;
    if (vpc) {
      lambdaSG = new ec2.SecurityGroup(this, "LambdaSG", {
        vpc,
        description: "Xorgate Lambda functions security group",
        allowAllOutbound: true,
      });

      if (dbSecurityGroup) {
        new ec2.CfnSecurityGroupIngress(this, "DbFromLambda", {
          groupId: dbSecurityGroup.securityGroupId,
          ipProtocol: "tcp",
          fromPort: 5432,
          toPort: 5432,
          sourceSecurityGroupId: lambdaSG.securityGroupId,
        });
      }
    }

    const lambdaRole = new iam.Role(this, "LambdaExecutionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Shared execution role for all Xorgate Lambda functions",
      managedPolicies: vpc
        ? [
            iam.ManagedPolicy.fromAwsManagedPolicyName(
              "service-role/AWSLambdaVPCAccessExecutionRole",
            ),
          ]
        : [],
    });

    bucket.grantReadWrite(lambdaRole);

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "rds-data:ExecuteStatement",
          "rds-data:BatchExecuteStatement",
          "rds-data:BeginTransaction",
          "rds-data:CommitTransaction",
          "rds-data:RollbackTransaction",
        ],
        resources: [clusterArn],
      }),
    );

    dbSecret.grantRead(lambdaRole);

    // Device provisioning (P1): mint IoT thing/cert, attach the base policy, create KVS channels.
    // Resource authorization is per-action: AttachThingPrincipal checks BOTH the thing and the
    // certificate; AttachPolicy/UpdateCertificate check the certificate. Grant these on both ARNs.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "IotProvisioning",
        actions: [
          "iot:CreateThing",
          "iot:DescribeThing",
          "iot:AttachThingPrincipal",
          "iot:AttachPolicy",
          "iot:UpdateCertificate",
        ],
        resources: [
          `arn:aws:iot:${this.region}:${this.account}:thing/*`,
          `arn:aws:iot:${this.region}:${this.account}:cert/*`,
        ],
      }),
    );
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        // CreateKeysAndCertificate / DescribeEndpoint do not support resource-level scoping.
        sid: "IotCreateKeysAndEndpoint",
        actions: ["iot:CreateKeysAndCertificate", "iot:DescribeEndpoint"],
        resources: ["*"],
      }),
    );
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "KvsChannels",
        actions: [
          "kinesisvideo:CreateSignalingChannel",
          "kinesisvideo:DescribeSignalingChannel",
        ],
        resources: [`arn:aws:kinesisvideo:${this.region}:${this.account}:channel/*`],
      }),
    );

    // Browser live-telemetry (P2): attach the AWS IoT policy to a caller's Cognito
    // identity so the browser can connect/subscribe over MQTT-over-WSS. iot:AttachPolicy
    // authorizes against the *target* (a Cognito identity id, not an ARN) → resource "*";
    // the handler only ever attaches the fixed BROWSER_IOT_POLICY_NAME.
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "IotAttachBrowserPolicy",
        actions: ["iot:AttachPolicy"],
        resources: ["*"],
      }),
    );
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CognitoGetId",
        actions: ["cognito-identity:GetId"],
        resources: [
          `arn:aws:cognito-identity:${this.region}:${this.account}:identitypool/${cognitoIdentityPoolId}`,
        ],
      }),
    );

    lambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AWSLambdaBasicExecutionRole",
      ),
    );

    const commonEnv: Record<string, string> = {
      NODE_ENV: isProd ? "production" : "development",
      DB_CLUSTER_ARN: clusterArn,
      DB_SECRET_ARN: dbSecret.secretArn,
      DB_NAME: dbName,
      BUCKET_NAME: bucket.bucketName,
      COGNITO_USER_POOL_ID: userPoolId,
      COGNITO_CLIENT_ID: userPoolClientId,
      IOT_THING_TYPE_NAME: iotThingTypeName,
      IOT_POLICY_NAME: iotPolicyName,
      BROWSER_IOT_POLICY_NAME: browserIotPolicyName,
      IOT_ROLE_ALIAS: iotRoleAlias,
      COGNITO_IDENTITY_POOL_ID: cognitoIdentityPoolId,
      COGNITO_USER_POOL_PROVIDER: cognitoUserPoolProvider,
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
    };

    const commonBundling: nodejs.BundlingOptions = {
      minify: true,
      sourceMap: true,
      target: "node20",
      externalModules: ["@aws-sdk/*"],
      forceDockerBundling: false,
    };

    const vpcProps: Pick<
      nodejs.NodejsFunctionProps,
      "vpc" | "vpcSubnets" | "securityGroups"
    > =
      vpc && lambdaSG
        ? {
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroups: [lambdaSG],
          }
        : {};

    const entryBase = path.join(__dirname, "../../src/handlers");

    const standardFnProps = (
      entry: string,
      description: string,
      withDb = true,
    ): nodejs.NodejsFunctionProps => ({
      entry,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      role: lambdaRole,
      // health Lambda doesn't touch the DB; skip VPC props to avoid the cold-start penalty.
      ...(withDb ? vpcProps : {}),
      environment: commonEnv,
      bundling: commonBundling,
      description,
    });

    const healthFn = new nodejs.NodejsFunction(
      this,
      "HealthFn",
      standardFnProps(path.join(entryBase, "health.ts"), "GET /health", false),
    );

    const meFn = new nodejs.NodejsFunction(
      this,
      "MeFn",
      standardFnProps(
        path.join(entryBase, "me.ts"),
        "GET /me — current user + memberships",
      ),
    );

    const organizationsFn = new nodejs.NodejsFunction(
      this,
      "OrganizationsFn",
      standardFnProps(
        path.join(entryBase, "organizations.ts"),
        "CRUD /organizations",
      ),
    );

    const membershipsFn = new nodejs.NodejsFunction(
      this,
      "MembershipsFn",
      standardFnProps(
        path.join(entryBase, "memberships.ts"),
        "CRUD /memberships",
      ),
    );

    const apiKeysFn = new nodejs.NodejsFunction(
      this,
      "ApiKeysFn",
      standardFnProps(path.join(entryBase, "api-keys.ts"), "CRUD /api-keys"),
    );

    const projectsFn = new nodejs.NodejsFunction(
      this,
      "ProjectsFn",
      standardFnProps(path.join(entryBase, "projects.ts"), "CRUD /projects"),
    );

    const deviceModelsFn = new nodejs.NodejsFunction(
      this,
      "DeviceModelsFn",
      standardFnProps(
        path.join(entryBase, "device-models.ts"),
        "CRUD /device-models (admin-write)",
      ),
    );

    const devicesFn = new nodejs.NodejsFunction(
      this,
      "DevicesFn",
      standardFnProps(path.join(entryBase, "devices.ts"), "CRUD /devices"),
    );

    const deviceProvisioningFn = new nodejs.NodejsFunction(this, "DeviceProvisioningFn", {
      ...standardFnProps(
        path.join(entryBase, "device-provisioning.ts"),
        "POST /devices/{id}/provision — IoT cert + KVS channels",
      ),
      // Provisioning makes several IoT/KVS round-trips; give it more headroom than the 10s default.
      timeout: cdk.Duration.seconds(30),
    });

    // GET /devices/{id}/kvs-channels (P3) — returns the device's KVS signaling
    // channels so the browser can run a WebRTC VIEWER. Reads Postgres only (no KVS
    // call, no new IAM); the browser mints its own scoped creds via Cognito.
    const deviceKvsChannelsFn = new nodejs.NodejsFunction(
      this,
      "DeviceKvsChannelsFn",
      standardFnProps(
        path.join(entryBase, "device-kvs-channels.ts"),
        "GET /devices/{id}/kvs-channels — KVS channels for the browser viewer",
      ),
    );

    // --- Live telemetry ingestion (P2): IoT Topic Rule -> Lambda -> Postgres ---
    // The ingestion Lambda has NO HTTP route; it is invoked directly by the IoT
    // rule below. The rule MUST be created in this (api) stack — iot-stack is
    // synthesized first and cannot reference this Lambda.
    const telemetryIngestFn = new nodejs.NodejsFunction(this, "TelemetryIngestFn", {
      ...standardFnProps(
        path.join(entryBase, "telemetry-ingest.ts"),
        "IoT rule -> telemetry_readings + device_latest + last_seen",
      ),
      // One message = up to 3 Data API round-trips (insert + upsert + heartbeat).
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
    });

    // EventBridge ~1 min -> flip stale `online` devices to `offline`.
    const offlineSweeperFn = new nodejs.NodejsFunction(
      this,
      "OfflineSweeperFn",
      standardFnProps(
        path.join(entryBase, "offline-sweeper.ts"),
        "Schedule (1m) -> flip stale online devices to offline",
      ),
    );
    new events.Rule(this, "OfflineSweeperSchedule", {
      description: "Flip stale online devices to offline (P2 telemetry)",
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(offlineSweeperFn)],
    });

    // Dead-letter queue for messages the rule could not act on (action failure).
    const telemetryDlq = new sqs.Queue(this, "TelemetryIngestDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    // The IoT rule assumes this role to write to the DLQ on action error.
    const telemetryRuleRole = new iam.Role(this, "TelemetryRuleRole", {
      assumedBy: new iam.ServicePrincipal("iot.amazonaws.com"),
      description: "Lets the telemetry IoT rule send failed messages to the DLQ",
    });
    telemetryDlq.grantSendMessages(telemetryRuleRole);

    const telemetryRule = new iot.CfnTopicRule(this, "TelemetryIngestRule", {
      // IoT rule names allow only [A-Za-z0-9_] — underscores, not the kebab convention.
      ruleName: isProd ? "xorgate_telemetry_ingest" : "xorgate_telemetry_ingest_dev",
      topicRulePayload: {
        sql: "SELECT *, topic(3) AS topicDeviceId FROM 'xorgate/devices/+/telemetry'",
        awsIotSqlVersion: "2016-03-23",
        ruleDisabled: false,
        actions: [{ lambda: { functionArn: telemetryIngestFn.functionArn } }],
        errorAction: {
          sqs: {
            queueUrl: telemetryDlq.queueUrl,
            roleArn: telemetryRuleRole.roleArn,
            useBase64: false,
          },
        },
      },
    });

    // Resource-based invoke permission keyed on the rule ARN. This keeps a clean
    // fn -> rule -> permission DAG (no cycle); do NOT instead give the rule an IAM
    // role with lambda:InvokeFunction. sourceAccount guards the confused-deputy.
    telemetryIngestFn.addPermission("AllowIotRuleInvoke", {
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      sourceArn: telemetryRule.attrArn,
      sourceAccount: this.account,
      action: "lambda:InvokeFunction",
    });

    const iotAttachPolicyFn = new nodejs.NodejsFunction(
      this,
      "IotAttachPolicyFn",
      standardFnProps(
        path.join(entryBase, "iot-attach-policy.ts"),
        "POST /iot/attach-policy — attach browser IoT policy to caller's Cognito identity",
      ),
    );

    const docsFn = new nodejs.NodejsFunction(this, "DocsFn", {
      entry: path.join(entryBase, "docs.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      role: lambdaRole,
      // No VPC props — docs Lambda doesn't touch DB or S3; avoids VPC cold-start penalty.
      // DOCS_BASE_URL is injected below once `this.api` exists.
      environment: { NODE_ENV: isProd ? "production" : "development" },
      bundling: commonBundling,
      description: "GET /docs (Swagger UI) + GET /openapi.json",
    });

    this.api = new apigwv2.HttpApi(this, "XorgateCoreApi", {
      apiName: isProd ? "xorgate-core-api" : "xorgate-core-api-dev",
      description: "Xorgate core backend HTTP API",
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: [
          "Authorization",
          "Content-Type",
          "X-Request-ID",
          "X-Organization-Id",
          "X-Project-Id",
        ],
        maxAge: cdk.Duration.hours(24),
      },
    });

    const healthInt = new apigwv2int.HttpLambdaIntegration(
      "HealthInt",
      healthFn,
    );
    const meInt = new apigwv2int.HttpLambdaIntegration("MeInt", meFn);
    const organizationsInt = new apigwv2int.HttpLambdaIntegration(
      "OrganizationsInt",
      organizationsFn,
    );
    const membershipsInt = new apigwv2int.HttpLambdaIntegration(
      "MembershipsInt",
      membershipsFn,
    );
    const apiKeysInt = new apigwv2int.HttpLambdaIntegration(
      "ApiKeysInt",
      apiKeysFn,
    );
    const projectsInt = new apigwv2int.HttpLambdaIntegration(
      "ProjectsInt",
      projectsFn,
    );
    const deviceModelsInt = new apigwv2int.HttpLambdaIntegration(
      "DeviceModelsInt",
      deviceModelsFn,
    );
    const devicesInt = new apigwv2int.HttpLambdaIntegration(
      "DevicesInt",
      devicesFn,
    );
    const deviceProvisioningInt = new apigwv2int.HttpLambdaIntegration(
      "DeviceProvisioningInt",
      deviceProvisioningFn,
    );
    const deviceKvsChannelsInt = new apigwv2int.HttpLambdaIntegration(
      "DeviceKvsChannelsInt",
      deviceKvsChannelsFn,
    );
    const iotAttachPolicyInt = new apigwv2int.HttpLambdaIntegration(
      "IotAttachPolicyInt",
      iotAttachPolicyFn,
    );
    const docsInt = new apigwv2int.HttpLambdaIntegration("DocsInt", docsFn);

    // Inject the API endpoint into the docs Lambda now that the api exists.
    docsFn.addEnvironment("DOCS_BASE_URL", this.api.apiEndpoint);

    this.api.addRoutes({
      path: "/health",
      methods: [apigwv2.HttpMethod.GET],
      integration: healthInt,
    });

    this.api.addRoutes({
      path: "/me",
      methods: [apigwv2.HttpMethod.GET],
      integration: meInt,
    });

    this.api.addRoutes({
      path: "/organizations",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: organizationsInt,
    });
    this.api.addRoutes({
      path: "/organizations/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: organizationsInt,
    });

    this.api.addRoutes({
      path: "/memberships",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: membershipsInt,
    });
    this.api.addRoutes({
      path: "/memberships/{id}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: membershipsInt,
    });

    this.api.addRoutes({
      path: "/api-keys",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: apiKeysInt,
    });
    this.api.addRoutes({
      path: "/api-keys/{id}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: apiKeysInt,
    });

    this.api.addRoutes({
      path: "/projects",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: projectsInt,
    });
    this.api.addRoutes({
      path: "/projects/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: projectsInt,
    });

    this.api.addRoutes({
      path: "/device-models",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: deviceModelsInt,
    });
    this.api.addRoutes({
      path: "/device-models/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: deviceModelsInt,
    });

    this.api.addRoutes({
      path: "/devices",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: devicesInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: devicesInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/provision",
      methods: [apigwv2.HttpMethod.POST],
      integration: deviceProvisioningInt,
    });
    this.api.addRoutes({
      path: "/devices/{id}/kvs-channels",
      methods: [apigwv2.HttpMethod.GET],
      integration: deviceKvsChannelsInt,
    });

    this.api.addRoutes({
      path: "/iot/attach-policy",
      methods: [apigwv2.HttpMethod.POST],
      integration: iotAttachPolicyInt,
    });

    this.api.addRoutes({
      path: "/docs",
      methods: [apigwv2.HttpMethod.GET],
      integration: docsInt,
    });
    this.api.addRoutes({
      path: "/openapi.json",
      methods: [apigwv2.HttpMethod.GET],
      integration: docsInt,
    });

    new cdk.CfnOutput(this, "ApiUrl", {
      value: this.api.apiEndpoint,
      exportName: `XorgateCoreApiEndpoint${exportSuffix}`,
      description: "API Gateway HTTP API endpoint URL",
    });

    new cdk.CfnOutput(this, "ApiId", {
      value: this.api.apiId,
      exportName: `XorgateCoreApiId${exportSuffix}`,
    });

    new cdk.CfnOutput(this, "DocsUrl", {
      value: `${this.api.apiEndpoint}/docs`,
      description: "Swagger UI URL",
    });
  }
}
