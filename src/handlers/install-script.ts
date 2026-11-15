import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index';
import {
  INSTALL_SCRIPT_PLACEHOLDERS,
  renderInstallScript,
} from '../assets/install-script';
import { renderRustBootstrap } from '../assets/install-script-rs';
import {
  rustRegistrationEnabled,
  rustRegistrationFlag,
  storedAgent,
} from '../services/device-agent';
import { apiHandler } from '../utils/api-handler';

const SHELL_HEADERS = {
  'Content-Type': 'text/x-shellscript; charset=utf-8',
  'Cache-Control': 'no-store',
};

function apiBaseUrl(): string {
  const v = process.env.API_BASE_URL;
  if (!v) throw new Error('API_BASE_URL env var is not set');
  // API_BASE_URL is a bare origin; the version lives here, with every other
  // route. The installer's two endpoints (`/v1/get/{code}` and
  // `/v1/device-registrations/{code}/claim`) are as versioned as the rest of
  // the API since the unversioned paths were deleted. Registration codes live
  // 15 minutes, so no previously-issued URL outlived the change.
  return `${v.replace(/\/$/, '')}/v1`;
}

// For invalid/used/expired codes (and config errors) we still return a runnable
// bash body that exits with a clear message, so the operator sees the problem
// instead of `bash` silently doing nothing.
function shellError(statusCode: number, message: string): APIGatewayProxyResultV2 {
  const safe = message.replace(/'/g, "'\\''");
  return {
    statusCode,
    headers: SHELL_HEADERS,
    body: `#!/usr/bin/env bash\nset -e\necho "[xorgate] ${safe}" >&2\nexit 1\n`,
  };
}

// GET /get/{code} (UNAUTHENTICATED). Served as text/x-shellscript so
// `curl -s URL -o install.sh; sudo bash install.sh` behaves predictably.
const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const code = event.pathParameters?.code;
  if (!code) {
    return shellError(400, 'missing registration code in URL');
  }

  const row = await db.query.deviceRegistrations.findFirst({
    where: eq(schema.deviceRegistrations.code, code),
  });

  if (!row) {
    return shellError(
      404,
      'this registration code is unknown; generate a new one in the web app',
    );
  }
  if (row.status === 'claimed') {
    return shellError(
      410,
      'this registration code was already used; generate a new one in the web app',
    );
  }
  if (row.status === 'expired' || row.expiresAt.getTime() < Date.now()) {
    return shellError(
      410,
      'this registration code is expired; generate a new one in the web app',
    );
  }

  const distBucketUrl = process.env.DEVICE_DIST_BUCKET_URL;
  if (!distBucketUrl) {
    return shellError(500, 'server misconfigured: DEVICE_DIST_BUCKET_URL not set');
  }
  const distVersion = process.env.DEVICE_DIST_VERSION ?? 'latest';

  // Which installer (dual-agent registration D2). 'js' and every legacy row get
  // today's install.sh, untouched. 'rust' gets the Rust bootstrap, but only
  // while this stage's flag allows Rust for the code's workspace: a code minted
  // while the flag was on and fetched after it flipped off is refused here.
  const agent = storedAgent(row.agent);
  if (agent === 'rust' && !rustRegistrationEnabled(rustRegistrationFlag(), row.workspaceId)) {
    return shellError(409, 'Rust registration is not enabled here; generate a JS code in the web app');
  }
  const render = agent === 'rust' ? renderRustBootstrap : renderInstallScript;

  const body = render({
    regCode: row.code,
    apiBase: apiBaseUrl(),
    distBucketUrl: distBucketUrl.replace(/\/$/, ''),
    distVersion,
  });

  // Belt-and-suspenders: never serve a script with an unsubstituted placeholder.
  for (const ph of INSTALL_SCRIPT_PLACEHOLDERS) {
    if (body.includes(ph)) {
      return shellError(500, `server error rendering install script (${ph})`);
    }
  }

  return { statusCode: 200, headers: SHELL_HEADERS, body };
};

export const handler = apiHandler(restHandler);
