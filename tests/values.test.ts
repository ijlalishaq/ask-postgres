import { describe, expect, it } from "vitest";
import { exactDecimal, normDecimal, sameResult, valueKey } from "../src/values.js";

const INT8 = 20;
const INT4 = 23;
const FLOAT4 = 700;
const FLOAT8 = 701;
const NUMERIC = 1700;
const TEXT = 25;
const BOOL = 16;
const DATE = 1082;
const TIMESTAMP = 1114;

describe("normDecimal", () => {
  it.each([
    ["007", "7"],
    ["-0.0", "0"],
    ["12.3400", "12.34"],
    ["-5.50", "-5.5"],
    ["0.001", "0.001"],
  ])("%s -> %s", (input, out) => expect(normDecimal(input)).toBe(out));
});

describe("exactDecimal", () => {
  it("writes out a double's exact binary value", () => {
    expect(exactDecimal(0.1)).toBe("0.1000000000000000055511151231257827021181583404541015625");
    expect(exactDecimal(0.5)).toBe("0.5");
    expect(exactDecimal(-2.25)).toBe("-2.25");
    expect(exactDecimal(1e21)).toBe("1000000000000000000000");
  });
});

// Each case is what Python says about the psycopg2 values these stand for.
describe("valueKey matches Python equality", () => {
  it("treats ints, numerics and exactly representable floats as the same number", () => {
    expect(valueKey("1", INT4)).toBe(valueKey("1", INT8));
    expect(valueKey("1", INT4)).toBe(valueKey("1.00", NUMERIC)); // 1 == Decimal("1.00")
    expect(valueKey("1", INT4)).toBe(valueKey("1", FLOAT8)); // 1 == 1.0
    expect(valueKey("0.5", NUMERIC)).toBe(valueKey("0.5", FLOAT8)); // Decimal("0.5") == 0.5
  });

  it("keeps Decimal and float apart when the float isn't exact", () => {
    expect(valueKey("0.1", NUMERIC)).not.toBe(valueKey("0.1", FLOAT8)); // Decimal("0.1") != 0.1
  });

  it("reads float4 text the way Python's float() does", () => {
    expect(valueKey("672.64", FLOAT4)).toBe(valueKey("672.64", FLOAT8));
  });

  it("treats booleans as 0 and 1", () => {
    expect(valueKey("t", BOOL)).toBe(valueKey("1", INT4)); // True == 1
    expect(valueKey("f", BOOL)).toBe(valueKey("0", INT4));
  });

  it("never mixes numbers, text and dates", () => {
    expect(valueKey("1", TEXT)).not.toBe(valueKey("1", INT4));
    expect(valueKey("2012-08-24", DATE)).not.toBe(valueKey("2012-08-24", TEXT));
    expect(valueKey("2012-08-24", DATE)).not.toBe(valueKey("2012-08-24 00:00:00", TIMESTAMP));
  });

  it("gives NULL its own key", () => {
    expect(valueKey(null, TEXT)).toBe(valueKey(null, INT4));
    expect(valueKey(null, TEXT)).not.toBe(valueKey("", TEXT));
  });
});

describe("sameResult", () => {
  const r = (oids: number[], rows: (string | null)[][]) => ({ oids, rows });

  it("ignores row order and duplicate rows", () => {
    expect(sameResult(r([TEXT], [["a"], ["b"], ["a"]]), r([TEXT], [["b"], ["a"]]))).toBe(true);
  });

  it("respects column order", () => {
    expect(sameResult(r([TEXT, INT4], [["a", "1"]]), r([INT4, TEXT], [["1", "a"]]))).toBe(false);
  });

  it("compares numbers across types", () => {
    expect(sameResult(r([INT8], [["3"]]), r([NUMERIC], [["3.0"]]))).toBe(true);
  });

  it("fails on a missing or extra row", () => {
    expect(sameResult(r([INT4], [["1"], ["2"]]), r([INT4], [["1"]]))).toBe(false);
    expect(sameResult(r([INT4], []), r([INT4], [["1"]]))).toBe(false);
  });

  it("fails on an extra column", () => {
    expect(sameResult(r([INT4, INT4], [["1", "2"]]), r([INT4], [["1"]]))).toBe(false);
  });
});
