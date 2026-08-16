import { describe, expect, test } from "bun:test";
import { nextCronFire, parseCron } from "./cron";

const utc = (value: string): number => Date.parse(value);

describe("scheduler cron (issue #86)", () => {
  test.each([
    ["* * * * *", "2026-08-17T12:00:00.000Z", "2026-08-17T12:01:00.000Z"],
    ["*/15 * * * *", "2026-08-17T12:01:00.000Z", "2026-08-17T12:15:00.000Z"],
    ["10-12 8 * * *", "2026-08-17T08:10:00.000Z", "2026-08-17T08:11:00.000Z"],
    ["5,20,55 9 * * *", "2026-08-17T09:20:00.000Z", "2026-08-17T09:55:00.000Z"],
    ["0 0 ? * 1", "2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z"],
    ["0 0 18 * ?", "2026-08-17T23:59:59.999Z", "2026-08-18T00:00:00.000Z"],
    ["0 0 * * *", "2026-08-17T00:00:00.000Z", "2026-08-18T00:00:00.000Z"],
    ["0 0 1 * ?", "2026-08-31T23:59:59.999Z", "2026-09-01T00:00:00.000Z"],
    ["0 0 1 1 ?", "2026-12-31T23:59:59.999Z", "2027-01-01T00:00:00.000Z"],
  ])("finds the next UTC fire for %s", (cron, after, expected) => {
    expect(nextCronFire(cron, utc(after))).toBe(utc(expected));
  });

  test("uses normal cron OR semantics when both day fields are restricted", () => {
    expect(nextCronFire("0 0 20 * 1", utc("2026-08-17T00:00:00.000Z"))).toBe(
      utc("2026-08-20T00:00:00.000Z"),
    );
  });

  test.each([
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 7",
    "* * ? * ?",
    "? * * * *",
    "*/0 * * * *",
    "1-0 * * * *",
    "1,,2 * * * *",
    "one * * * *",
  ])("rejects malformed cron: %s", (cron) => {
    expect(() => parseCron(cron)).toThrow(/invalid cron/i);
    expect(() => nextCronFire(cron, 0)).toThrow(/invalid cron/i);
  });

  test("rejects an invalid timestamp", () => {
    expect(() => nextCronFire("* * * * *", Number.NaN)).toThrow(/afterMs/i);
  });
});
