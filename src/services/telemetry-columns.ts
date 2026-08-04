/**
 * Ordered column set for the Telemetry History table (`?shape=table`).
 *
 * This is the server-side move of a decision the browser used to make: which
 * columns the history table has, and in what order. It was derived client-side
 * from the device model's `io_capabilities` (frontend `$id.telemetry.tsx`, via
 * `src/lib/capability-metrics.ts`) and doubled as the `metric=` filter sent back
 * to this endpoint. Deriving it here removes two sequential round-trips before
 * the first row renders, and makes the column set authoritative rather than
 * "whatever this page happened to contain".
 *
 * ⚠ **This must reproduce the frontend's composition exactly.** The columns and
 * the metric filter are derived from one value on purpose (see the handler): if
 * they diverge, the table either renders columns that can never have data or
 * drops data it already paid to fetch. Two frontend quirks are therefore
 * mirrored deliberately rather than "fixed" here:
 *
 * 1. **System field order follows the MODEL, not the allowlist.** The frontend
 *    filters the model's declared `system.fields` through SYSTEM_CHART_FIELDS,
 *    so the model's declaration order wins. Sorting by the allowlist instead
 *    would silently reorder every user's columns.
 * 2. **GPS is included on the presence of the `gps` OBJECT, not on it declaring
 *    fields.** The frontend tests `Boolean(caps?.comm?.gps)`. A model with
 *    `comm.gps = { fields: [] }` therefore gets lat/lon columns that stay empty.
 *    Arguably wrong, but it is the shipped behaviour and changing it is a
 *    product decision, not a refactor.
 *
 * Related and deliberately NOT reused: `producibleMetricKeys()` in
 * services/workflow-capabilities.ts walks the same capability shape but answers
 * a different question — *every* metric key a model can emit, as an unordered
 * Set, for workflow compatibility. The history table wants a narrower, ordered
 * projection (no `lte.*`, no non-chartable system fields, a fixed column order).
 * The two are kept separate for that reason; keep them in sync in spirit only.
 */

/** Loose structural view of the stored jsonb — it may predate the current schema. */
type Caps =
  | {
      sensors?: {
        imu?: {
          /** Legacy alias for `accel`, still present on older models. */
          axes?: string[] | null;
          accel?: string[] | null;
          quaternion?: string[] | null;
          euler?: string[] | null;
        } | null;
      } | null;
      comm?: {
        gps?: { fields?: string[] | null } | null;
      } | null;
      system?: { fields?: string[] | null } | null;
    }
  | null
  | undefined;

/**
 * Chartable system fields: continuous quantities only. The throttle bitmask and
 * the boot-static psu_max_current are meaningless as a time series. Mirrors
 * SYSTEM_CHART_FIELDS in the frontend's capability-metrics.ts.
 */
const SYSTEM_CHART_FIELDS = ['cpu_usage', 'ram_usage', 'cpu_temp', 'disk_usage', 'rail_5v'];

/** GPS columns the history table shows (the full GPS group is far wider). */
const GPS_COLUMNS = ['gps.lat', 'gps.lon'];

function list(v: readonly string[] | null | undefined): string[] {
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
}

/**
 * IMU metrics in display order: accel, then quaternion, then euler — the
 * frontend's `imuMetrics()` order.
 */
function imuColumns(caps: Caps): string[] {
  const imu = caps?.sensors?.imu;
  if (!imu) return [];
  const accel = list(imu.accel ?? imu.axes);
  return [
    ...accel.map((a) => `imu.accel_${a}`),
    ...list(imu.quaternion).map((q) => `imu.quat_${q}`),
    ...list(imu.euler).map((e) => `imu.euler_${e}`),
  ];
}

/** Chartable system metrics, in the model's declared order (see quirk 1 above). */
function systemColumns(caps: Caps): string[] {
  return list(caps?.system?.fields)
    .filter((f) => SYSTEM_CHART_FIELDS.includes(f))
    .map((f) => `system.${f}`);
}

/**
 * Ordered history-table column keys for a device model's capabilities.
 *
 * Empty when the model declares nothing usable (or `ioCapabilities` is null) —
 * the caller then falls back to discovering columns from the page's own rows and
 * says so in the response, so a client can tell "the model declares nothing"
 * apart from "there is no data".
 *
 * For the Pi model this returns exactly 17 keys.
 */
export function historyColumnKeys(caps: unknown): string[] {
  const c = caps as Caps;
  const gps = c?.comm?.gps ? GPS_COLUMNS : [];
  return [...imuColumns(c), ...systemColumns(c), ...gps];
}

/**
 * Order an explicit `metric=` filter the way the model would present it, so an
 * API caller's column order is stable and matches the UI. Requested metrics the
 * model does not declare keep their requested order and are appended.
 */
export function orderColumnsByModel(requested: string[], caps: unknown): string[] {
  const rank = new Map(historyColumnKeys(caps).map((k, i) => [k, i]));
  const known = requested.filter((m) => rank.has(m));
  const unknown = requested.filter((m) => !rank.has(m));
  known.sort((a, b) => rank.get(a)! - rank.get(b)!);
  return [...known, ...unknown];
}

/** A flat reading row, as selected from telemetry_readings. */
export interface ReadingRow {
  ts: Date;
  metric: string;
  value: number | null;
}

/** One table row: a timestamp and its values, positional against `columns`. */
export interface TableRow {
  ts: string;
  v: Array<number | null>;
}

/**
 * Pivot flat rows into the table shape's positional rows.
 *
 * ⚠ `v` is positional against `columns` and its length ALWAYS equals
 * `columns.length` — `null` means "no reading for this metric at this
 * timestamp". Trailing nulls are never trimmed: a short array would make the
 * client mis-index every column after the gap. Dropping the metric key from
 * every cell is most of the payload win, and it only works if the array is
 * dense.
 *
 * Input arrives ordered (ts <dir>, metric asc), so first-seen order of the
 * timestamps is already the requested display order and the output needs no
 * sort. Metrics outside `columns` are ignored rather than appended: the column
 * set is authoritative, and a stray metric would shift every later index.
 */
export function pivotRows(rows: ReadingRow[], columns: string[]): TableRow[] {
  const index = new Map(columns.map((k, i) => [k, i]));
  const out: TableRow[] = [];
  const byTs = new Map<number, number>(); // epoch → position in `out`
  for (const r of rows) {
    const col = index.get(r.metric);
    if (col === undefined) continue;
    const epoch = r.ts.getTime();
    let at = byTs.get(epoch);
    if (at === undefined) {
      at = out.length;
      byTs.set(epoch, at);
      out.push({ ts: r.ts.toISOString(), v: new Array<number | null>(columns.length).fill(null) });
    }
    out[at].v[col] = r.value;
  }
  return out;
}
