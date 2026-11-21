import assert from "node:assert/strict";
import { test } from "node:test";
import {
  depositorNameMatches,
  expiryReminderStage,
  formatKrw,
  normalizeDepositorName,
  periodEnd,
  priceForBots,
  requestCode,
  shouldSendExpiryReminder,
} from "./utils.js";

test("priceForBots charges 3900 per bot", () => {
  assert.equal(priceForBots(1), 3_900);
  assert.equal(priceForBots(3), 11_700);
  assert.equal(priceForBots(-1), 0);
});

test("normalizeDepositorName removes spaces and separators", () => {
  assert.equal(normalizeDepositorName(" 홍 길동 "), "홍길동");
  assert.equal(normalizeDepositorName("HONG-GIL DONG"), "honggildong");
});

test("depositorNameMatches handles exact and masked names", () => {
  assert.equal(depositorNameMatches("홍길동", "홍길동"), "exact");
  assert.equal(depositorNameMatches("홍길동", "홍*동"), "masked");
  assert.equal(depositorNameMatches("홍길동", "김*동"), "mismatch");
  assert.equal(depositorNameMatches("홍길동", "홍길"), "mismatch");
});

test("periodEnd adds 30 days per month", () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(periodEnd(start, 1).toISOString(), "2026-01-31T00:00:00.000Z");
  assert.equal(periodEnd(start, 2).toISOString(), "2026-03-02T00:00:00.000Z");
});

test("formatKrw uses Korean formatting", () => {
  assert.equal(formatKrw(3900), "3,900원");
});

test("requestCode has expected format", () => {
  const code = requestCode();
  assert.match(code, /^HB-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
});

test("expiryReminderStage maps remaining days to D-3/D-1/D-day", () => {
  assert.equal(expiryReminderStage(10), null);
  assert.equal(expiryReminderStage(4), null);
  assert.equal(expiryReminderStage(3), 3);
  assert.equal(expiryReminderStage(2), 3);
  assert.equal(expiryReminderStage(2.4), 3);
  assert.equal(expiryReminderStage(1), 1);
  assert.equal(expiryReminderStage(0.2), 1);
  assert.equal(expiryReminderStage(0), 0);
  assert.equal(expiryReminderStage(-5), 0);
});

test("shouldSendExpiryReminder only moves forward", () => {
  assert.equal(shouldSendExpiryReminder(3, null), true);
  assert.equal(shouldSendExpiryReminder(3, undefined), true);
  assert.equal(shouldSendExpiryReminder(3, 3), false);
  assert.equal(shouldSendExpiryReminder(1, 3), true);
  assert.equal(shouldSendExpiryReminder(1, 1), false);
  assert.equal(shouldSendExpiryReminder(0, 1), true);
  assert.equal(shouldSendExpiryReminder(0, 0), false);
  // A late D-3 reminder must not fire after D-1 was already sent.
  assert.equal(shouldSendExpiryReminder(3, 1), false);
});
