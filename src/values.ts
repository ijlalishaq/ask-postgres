/**
 * Canonical keys for result values, so two result sets can be compared the way BIRD's evaluator
 * compares them: as Python sets of tuples fetched with psycopg2.
 *
 * The rules that follow from that:
 *  - numbers compare by exact value across types: 1 == 1.0 == Decimal("1"), and True == 1
 *  - a float is its exact binary value, so Decimal("0.1") != 0.1 but Decimal("0.5") == 0.5
 *  - text, dates, timestamps and times only equal values of their own kind
 *
 * Values arrive as the raw text Postgres sent, together with the column's type OID.
 */

// Type OIDs from pg_type.
const BOOL = 16;
const INTS = new Set([20, 21, 23, 26]); // int8, int2, int4, oid
const FLOATS = new Set([700, 701]); // float4, float8
const NUMERIC = 1700;
const DATE = 1082;
const TIME = 1083;
const TIMESTAMP = 1114;
const TIMESTAMPTZ = 1184;

/** Normalises a plain decimal string: "-007.2500" -> "-7.25", "-0.0" -> "0". */
export function normDecimal(s: string): string {
  let neg = s.startsWith("-");
  let body = s.replace(/^[-+]/, "");
  let [int = "", frac = ""] = body.split(".");
  int = int.replace(/^0+/, "") || "0";
  frac = frac.replace(/0+$/, "");
  body = frac ? `${int}.${frac}` : int;
  if (body === "0") neg = false;
  return (neg ? "-" : "") + body;
}

/** The exact decimal expansion of a double, e.g. 0.1 -> "0.1000000000000000055511151231257827021181583404541015625". */
export function exactDecimal(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x) && Math.abs(x) < 2 ** 53) return normDecimal(String(x));
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const neg = bits >> 63n === 1n;
  const expBits = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let exp: number;
  if (expBits === 0) {
    exp = -1074; // subnormal
  } else {
    mant |= 1n << 52n;
    exp = expBits - 1075;
  }
  let digits: string;
  if (exp >= 0) {
    digits = (mant << BigInt(exp)).toString();
  } else {
    const k = -exp;
    const scaled = (mant * 5n ** BigInt(k)).toString().padStart(k + 1, "0");
    digits = `${scaled.slice(0, -k)}.${scaled.slice(-k)}`;
  }
  return normDecimal((neg ? "-" : "") + digits);
}

/** Key for one value. Numbers share the "n:" space, everything else is kept apart by kind. */
export function valueKey(raw: string | null, oid: number): string {
  if (raw === null) return "null";
  if (oid === BOOL) return raw === "t" ? "n:1" : "n:0";
  if (INTS.has(oid)) return `n:${normDecimal(raw)}`;
  if (oid === NUMERIC) return raw === "NaN" ? "n:NaN" : `n:${normDecimal(raw)}`;
  if (FLOATS.has(oid)) return `n:${exactDecimal(Number(raw))}`;
  if (oid === DATE) return `date:${raw}`;
  if (oid === TIME) return `time:${raw}`;
  if (oid === TIMESTAMP) return `ts:${raw}`;
  if (oid === TIMESTAMPTZ) return `tstz:${new Date(raw.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")).toISOString()}`;
  return `s:${raw}`;
}

export function rowKey(row: (string | null)[], oids: number[]): string {
  return JSON.stringify(row.map((v, i) => valueKey(v, oids[i] ?? 25)));
}

export interface RawResult {
  oids: number[];
  rows: (string | null)[][];
}

/** BIRD's execution match: the two results are equal as sets of rows. */
export function sameResult(a: RawResult, b: RawResult): boolean {
  const ka = new Set(a.rows.map((r) => rowKey(r, a.oids)));
  const kb = new Set(b.rows.map((r) => rowKey(r, b.oids)));
  if (ka.size !== kb.size) return false;
  for (const k of ka) if (!kb.has(k)) return false;
  return true;
}
