import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { apiHandler } from '../utils/api-handler';

const restHandler = async (
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      stage: process.env.NODE_ENV === 'production' ? 'prod' : 'dev',
    }),
  };
};

export const handler = apiHandler(restHandler);
