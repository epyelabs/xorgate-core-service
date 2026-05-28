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
