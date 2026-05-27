import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface XorgateCoreAuthStackProps extends cdk.StackProps {
  stage: 'dev' | 'prod';
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
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolClient = this.userPool.addClient('SpaClient', {
      generateSecret: false,
      authFlows: { userSrp: true },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
