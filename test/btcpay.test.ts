import test from "node:test";
import assert from "node:assert/strict";
import { MockPluginContext } from "@droposs/plugin-sdk";
import Plugin from "../src/index.js";

test("drop-payment-btcpay registers a payment gateway", async () => {
  const ctx = new MockPluginContext("drop-payment-btcpay", ["commerce:payment", "network"]);
  await new Plugin().init(ctx);
  assert.equal(ctx.paymentGateways.size, 1);
  assert.equal(ctx.paymentGateways.get("btcpay")?.name, "BTCPay Server");
});
