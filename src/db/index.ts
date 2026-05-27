import { drizzle } from 'drizzle-orm/aws-data-api/pg';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import * as schema from './schema';

const rdsDataClient = new RDSDataClient({});

export const db = drizzle(rdsDataClient, {
  database: process.env.DB_NAME!,
  secretArn: process.env.DB_SECRET_ARN!,
  resourceArn: process.env.DB_CLUSTER_ARN!,
  schema,
});

export type DB = typeof db;

export { schema };
