import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface XorgateCoreAuthStackProps extends cdk.StackProps {
  stage: 'dev' | 'prod';
  /**
   * Google OAuth web client ID. When set, a Cognito Hosted-UI domain + Google
   * identity provider are provisioned and the SPA client gains the OAuth
   * authorization-code flow. When omitted, the pool keeps Cognito-only auth,
   * so a deploy without Google configured is byte-for-byte what it was.
   */
  googleClientId?: string;
  /**
   * Hosted-UI prefix domain (globally unique across Cognito). Defaults to
   * `xorgate-auth` / `xorgate-authdev`. Only used when googleClientId is set.
   */
  hostedUiDomainPrefix?: string;
  /**
   * Web origins allowed as OAuth callback/logout targets, e.g.
   * `['http://localhost:5173', 'https://dev.xorgate.io']`. Callback URLs become
   * `${origin}/auth/callback`; logout URLs become `${origin}/login`, matching
   * what xorgate-web derives from its page origin.
   */
  webAppUrls?: string[];
  /**
   * Public origin of xorgate-web for this stage (the links inside emails),
   * e.g. `https://console.xorgate.io`.
   */
  appUrl: string;
  /**
   * Send the pool's emails (verification, invitation, password reset) from
   * xorgate's own SES identity instead of Cognito's default sender. Only valid
   * once the domain's DKIM records resolve AND the SES account is out of the
   * sandbox — before that, every pool email would fail to send — so this is
   * flipped per stage from bin/app.ts (`cognitoEmailViaSes`), not defaulted on.
   */
  sesEmail?: {
    fromAddress: string;
    fromName: string;
    domain: string;
    configurationSetName: string;
  };
}

export class XorgateCoreAuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: XorgateCoreAuthStackProps) {
    super(scope, id, props);

    const isProd = props.stage === 'prod';

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      signInAliases: { email: true },
      selfSignUpEnabled: true,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 8, requireSymbols: false, requireUppercase: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Subject and body come from the CustomMessage trigger below; only the
      // SENDER is decided here, and only once the SES identity is verified and
      // the account is out of the sandbox (see the prop's docs).
      email: props.sesEmail
        ? cognito.UserPoolEmail.withSES({
            fromEmail: props.sesEmail.fromAddress,
            fromName: props.sesEmail.fromName,
            sesVerifiedDomain: props.sesEmail.domain,
            sesRegion: this.region,
            configurationSetName: props.sesEmail.configurationSetName,
          })
        : cognito.UserPoolEmail.withCognito(),
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const bundling: nodejs.BundlingOptions = {
      minify: true,
      sourceMap: true,
      target: 'node20',
      externalModules: ['@aws-sdk/*'],
      forceDockerBundling: false,
    };

    // Every email the pool sends — verification code, invitation with the
    // temporary password, password-reset code — is re-rendered in xorgate's
    // own template by this trigger (src/email/templates.ts). Attached
    // UNCONDITIONALLY, unlike the account-linking trigger below: the pool
    // sends these mails whether or not federation is configured, and the
    // branding is independent of which sender delivers them.
    this.userPool.addTrigger(
      cognito.UserPoolOperation.CUSTOM_MESSAGE,
      new nodejs.NodejsFunction(this, 'CustomMessageTrigger', {
        entry: path.join(__dirname, '../../src/handlers/cognito-custom-message.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: cdk.Duration.seconds(5),
        bundling,
        environment: { APP_URL: props.appUrl, STAGE: props.stage },
        description:
          'Cognito CustomMessage: branded verification / invitation / reset emails',
      }),
    );

    // Hosted-UI federation (Google) is wired only when a Google client ID is
    // provided. Every federated login still yields a normal Cognito ID token
    // for the same app client, so the API's JWT verification and first-sight
    // user provisioning (middleware/auth.ts) need no changes.
    const federationEnabled = Boolean(props.googleClientId);
    const identityProviders: cognito.UserPoolClientIdentityProvider[] = [
      cognito.UserPoolClientIdentityProvider.COGNITO,
    ];
    let googleIdp: cognito.UserPoolIdentityProviderGoogle | undefined;
    const webAppUrls = props.webAppUrls ?? ['http://localhost:5173'];

    if (federationEnabled) {
      const domainPrefix = props.hostedUiDomainPrefix ?? (isProd ? 'xorgate-auth' : 'xorgate-authdev');
      this.userPool.addDomain('HostedUiDomain', {
        cognitoDomain: { domainPrefix },
      });

      // Provider secret(s) live in Secrets Manager (one JSON secret per stage,
      // key `googleClientSecret`), populated out-of-band. Never commit the value.
      const oauthSecret = secretsmanager.Secret.fromSecretNameV2(
        this,
        'OauthProvidersSecret',
        isProd ? 'xorgate/oauth-providers' : 'xorgate/oauth-providers-dev',
      );

      googleIdp = new cognito.UserPoolIdentityProviderGoogle(this, 'GoogleIdp', {
        userPool: this.userPool,
        clientId: props.googleClientId!,
        clientSecretValue: oauthSecret.secretValueFromJson('googleClientSecret'),
        scopes: ['openid', 'email', 'profile'],
        // email mapping is mandatory: the API provisions users from the ID
        // token's email claim. name is best-effort display data.
        attributeMapping: {
          email: cognito.ProviderAttribute.GOOGLE_EMAIL,
          fullname: cognito.ProviderAttribute.GOOGLE_NAME,
        },
      });

      identityProviders.push(cognito.UserPoolClientIdentityProvider.GOOGLE);

      new cdk.CfnOutput(this, 'HostedUiBaseUrl', {
        value: `https://${domainPrefix}.auth.${this.region}.amazoncognito.com`,
      });

      // Account linking: one identity per email across password and Google
      // logins. PreSignUp links a first federated sign-in onto an existing
      // native user; PostConfirmation absorbs a pre-existing google_ user into
      // a fresh native signup. See the handler for the linking rules.
      const linkTrigger = new nodejs.NodejsFunction(this, 'AccountLinkTrigger', {
        entry: path.join(__dirname, '../../src/handlers/cognito-triggers.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        bundling,
      });
      // A standalone Policy (not the role's DefaultPolicy) breaks the circular
      // dependency pool -> trigger fn -> role/DefaultPolicy -> pool ARN: the
      // function does not depend on this policy, and trigger invocations only
      // need the permissions at runtime, not at pool creation.
      new iam.Policy(this, 'AccountLinkTriggerPolicy', {
        roles: [linkTrigger.role!],
        statements: [
          new iam.PolicyStatement({
            actions: [
              'cognito-idp:ListUsers',
              'cognito-idp:AdminLinkProviderForUser',
              'cognito-idp:AdminDeleteUser',
            ],
            resources: [this.userPool.userPoolArn],
          }),
        ],
      });
      this.userPool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, linkTrigger);
      this.userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, linkTrigger);
    }

    this.userPoolClient = this.userPool.addClient('SpaClient', {
      generateSecret: false,
      authFlows: { userSrp: true },
      supportedIdentityProviders: identityProviders,
      ...(federationEnabled
        ? {
            oAuth: {
              flows: { authorizationCodeGrant: true },
              scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
              callbackUrls: webAppUrls.map((u) => `${u}/auth/callback`),
              logoutUrls: webAppUrls.map((u) => `${u}/login`),
            },
          }
        : {}),
    });

    // The client must be created after the IdP so Cognito accepts GOOGLE in
    // supportedIdentityProviders.
    if (googleIdp) {
      this.userPoolClient.node.addDependency(googleIdp);
    }

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
