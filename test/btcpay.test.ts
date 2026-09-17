import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MockPluginContext } from "@droposs/plugin-sdk";
import type { PluginStorage } from "@droposs/plugin-sdk";
import Plugin, {
  BTCPAY_STORAGE_KEYS,
  BtcpayGateway,
  WebhookVerificationError,
  resolveBtcpayConfig,
  verifyBtcpaySignature,
} from "../src/index.js";
import type { HttpRequest } from "../src/index.js";

const WEBHOOK_SECRET = "btcpay_webhook_secret";
const API_BASE = "https://btcpay.example.org/api/v1";

function signBody(rawBody: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex");
}

function createStorage(values: Record<string, unknown>): Pick<PluginStorage, "get"> {
  return {
    get: async <T>(key: string): Promise<T | null> =>
      key in values ? (values[key] as T) : null,
  };
}

function settledEvent(orderId: string): string {
  return JSON.stringify({
    deliveryId: "delivery_1",
    type: "InvoiceSettled",
    invoiceId: "inv_123",
    metadata: { orderId },
  });
}

test("drop-payment-btcpay registers a payment gateway", async () => {
  const ctx = new MockPluginContext("drop-payment-btcpay", ["commerce:payment", "storage", "network"]);
  await new Plugin().init(ctx);
  assert.equal(ctx.paymentGateways.size, 1);
  assert.equal(ctx.paymentGateways.get("btcpay")?.name, "BTCPay Server");
});

test("resolveBtcpayConfig prefers storage over environment", async () => {
  const config = await resolveBtcpayConfig(
    createStorage({
      [BTCPAY_STORAGE_KEYS.apiBaseUrl]: "https://stored.example.org/api/v1",
      [BTCPAY_STORAGE_KEYS.storeId]: "stored-store",
      [BTCPAY_STORAGE_KEYS.webhookSecret]: "stored-secret",
    }),
    {
      BTCPAY_BASE_URL: "https://env.example.org/api/v1",
      BTCPAY_STORE_ID: "env-store",
      BTCPAY_API_KEY: "env-key",
    },
  );
  assert.deepEqual(config, {
    apiBaseUrl: "https://stored.example.org/api/v1",
    storeId: "stored-store",
    apiKey: "env-key",
    webhookSecret: "stored-secret",
  });
});

test("resolveBtcpayConfig falls back to environment", async () => {
  const config = await resolveBtcpayConfig(createStorage({}), {
    BTCPAY_BASE_URL: "https://env.example.org/api/v1",
    BTCPAY_STORE_ID: "env-store",
    BTCPAY_API_KEY: "env-key",
    BTCPAY_WEBHOOK_SECRET: "env-secret",
  });
  assert.deepEqual(config, {
    apiBaseUrl: "https://env.example.org/api/v1",
    storeId: "env-store",
    apiKey: "env-key",
    webhookSecret: "env-secret",
  });
});

test("resolveBtcpayConfig has no placeholder default", async () => {
  const config = await resolveBtcpayConfig(createStorage({}), {});
  assert.equal(config.apiBaseUrl, undefined);
  assert.equal(config.storeId, undefined);
  assert.equal(config.webhookSecret, undefined);
});

test("createPaymentIntent requires a configured base URL", async () => {
  const gateway = new BtcpayGateway("key", async () => new Response("{}"));
  await assert.rejects(
    gateway.createPaymentIntent({ orderId: "o", amount: 1, currency: "USD" }),
    /base URL is not configured/,
  );
});

test("createPaymentIntent requires a configured store id", async () => {
  const gateway = new BtcpayGateway("key", async () => new Response("{}"), {
    apiBaseUrl: API_BASE,
  });
  await assert.rejects(
    gateway.createPaymentIntent({ orderId: "o", amount: 1, currency: "USD" }),
    /store id is not configured/,
  );
});

test("createPaymentIntent requires an API key", async () => {
  const gateway = new BtcpayGateway(undefined, async () => new Response("{}"), {
    apiBaseUrl: API_BASE,
  });
  await assert.rejects(
    gateway.createPaymentIntent({ orderId: "o", amount: 1, currency: "USD" }),
    /API key is not configured/,
  );
});

test("createPaymentIntent posts JSON to the configured deployment", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: HttpRequest = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        id: "inv_1",
        checkoutLink: "https://pay.example.org/i/inv_1",
        status: "New",
      }),
      { status: 200 },
    );
  };
  const gateway = new BtcpayGateway("api-key", fetchFn, {
    apiBaseUrl: `${API_BASE}/`,
    storeId: "store-1",
  });
  const result = await gateway.createPaymentIntent({
    orderId: "order-1",
    amount: 25,
    currency: "USD",
    metadata: { gameId: "g1" },
  });
  assert.equal(calls[0].url, `${API_BASE}/stores/store-1/invoices`);
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer api-key");
  const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
  assert.deepEqual(body, {
    orderId: "order-1",
    amount: 25,
    currency: "USD",
    metadata: { orderId: "order-1", gameId: "g1" },
  });
  assert.deepEqual(result, {
    intentId: "inv_1",
    clientSecret: undefined,
    checkoutUrl: "https://pay.example.org/i/inv_1",
    status: "pending",
  });
});

test("createPaymentIntent rejects invalid base URLs", async () => {
  const gateway = new BtcpayGateway("api-key", async () => new Response("{}"), {
    apiBaseUrl: "not a url",
  });
  await assert.rejects(
    gateway.createPaymentIntent({ orderId: "o", amount: 1, currency: "USD" }),
    /not a valid absolute URL/,
  );
});

test("createPaymentIntent surfaces BTCPay API errors", async () => {
  const gateway = new BtcpayGateway("api-key", async () => new Response("nope", { status: 403 }), {
    apiBaseUrl: API_BASE,
    storeId: "store-1",
  });
  await assert.rejects(
    gateway.createPaymentIntent({ orderId: "o", amount: 1, currency: "USD" }),
    /BTCPay Server checkout failed: 403/,
  );
});

test("verifyBtcpaySignature accepts sha256-prefixed and bare hex", () => {
  const rawBody = settledEvent("order-1");
  const signature = signBody(rawBody);
  assert.doesNotThrow(() =>
    verifyBtcpaySignature({ rawBody, signatureHeader: `sha256=${signature}`, secret: WEBHOOK_SECRET }),
  );
  assert.doesNotThrow(() =>
    verifyBtcpaySignature({ rawBody, signatureHeader: signature, secret: WEBHOOK_SECRET }),
  );
});

test("verifyBtcpaySignature rejects invalid signatures", () => {
  const rawBody = settledEvent("order-1");
  assert.throws(
    () => verifyBtcpaySignature({ rawBody, signatureHeader: `sha256=${"0".repeat(64)}`, secret: WEBHOOK_SECRET }),
    WebhookVerificationError,
  );
  assert.throws(
    () => verifyBtcpaySignature({ rawBody, signatureHeader: `sha256=${signBody("other body")}`, secret: WEBHOOK_SECRET }),
    /signature verification failed/,
  );
});

test("verifyBtcpaySignature rejects missing or malformed headers", () => {
  const rawBody = settledEvent("order-1");
  assert.throws(
    () => verifyBtcpaySignature({ rawBody, signatureHeader: undefined, secret: WEBHOOK_SECRET }),
    /Missing BTCPay-Sig/,
  );
  assert.throws(
    () => verifyBtcpaySignature({ rawBody, signatureHeader: "sha256=not-hex", secret: WEBHOOK_SECRET }),
    /malformed/,
  );
});

test("verifyBtcpaySignature fails closed without a configured secret", () => {
  const rawBody = settledEvent("order-1");
  assert.throws(
    () => verifyBtcpaySignature({ rawBody, signatureHeader: `sha256=${signBody(rawBody)}`, secret: "" }),
    /webhook secret is not configured/,
  );
});

test("handleWebhook verifies and maps a settled invoice", async () => {
  const rawBody = settledEvent("order-42");
  const gateway = new BtcpayGateway("key", async () => new Response("{}"), {
    apiBaseUrl: API_BASE,
    webhookSecret: WEBHOOK_SECRET,
  });
  const result = await gateway.handleWebhook(rawBody, {
    "BTCPay-Sig": `sha256=${signBody(rawBody)}`,
  });
  assert.equal(result.orderId, "order-42");
  assert.equal(result.status, "succeeded");
  assert.equal(result.transactionId, "inv_123");
});

test("handleWebhook matches header names case-insensitively", async () => {
  const rawBody = settledEvent("order-42");
  const gateway = new BtcpayGateway("key", async () => new Response("{}"), {
    webhookSecret: WEBHOOK_SECRET,
  });
  const result = await gateway.handleWebhook(rawBody, {
    "btcpay-sig": `sha256=${signBody(rawBody)}`,
  });
  assert.equal(result.orderId, "order-42");
});

test("handleWebhook maps legacy posData and status", async () => {
  const rawBody = JSON.stringify({
    id: "inv_legacy",
    status: "paid",
    posData: JSON.stringify({ orderId: "order-legacy" }),
  });
  const gateway = new BtcpayGateway("key", async () => new Response("{}"), {
    webhookSecret: WEBHOOK_SECRET,
  });
  const result = await gateway.handleWebhook(rawBody, {
    "BTCPay-Sig": `sha256=${signBody(rawBody)}`,
  });
  assert.equal(result.orderId, "order-legacy");
  assert.equal(result.status, "succeeded");
  assert.equal(result.transactionId, "inv_legacy");
});

test("handleWebhook maps expired and refunded events", async () => {
  const gateway = new BtcpayGateway("key", async () => new Response("{}"), {
    webhookSecret: WEBHOOK_SECRET,
  });
  const expiredBody = JSON.stringify({ type: "InvoiceExpired", invoiceId: "inv_2" });
  const expired = await gateway.handleWebhook(expiredBody, {
    "BTCPay-Sig": `sha256=${signBody(expiredBody)}`,
  });
  assert.equal(expired.status, "failed");
  const refundedBody = JSON.stringify({ type: "InvoiceRefunded", invoiceId: "inv_3" });
  const refunded = await gateway.handleWebhook(refundedBody, {
    "BTCPay-Sig": `sha256=${signBody(refundedBody)}`,
  });
  assert.equal(refunded.status, "refunded");
});

test("handleWebhook rejects an invalid signature", async () => {
  const rawBody = settledEvent("order-42");
  const gateway = new BtcpayGateway("key", async () => new Response("{}"), {
    webhookSecret: WEBHOOK_SECRET,
  });
  await assert.rejects(
    gateway.handleWebhook(rawBody, { "BTCPay-Sig": `sha256=${"f".repeat(64)}` }),
    WebhookVerificationError,
  );
});

test("handleWebhook fails closed when no webhook secret is configured", async () => {
  const rawBody = settledEvent("order-42");
  const gateway = new BtcpayGateway("key", async () => new Response("{}"));
  await assert.rejects(
    gateway.handleWebhook(rawBody, { "BTCPay-Sig": `sha256=${signBody(rawBody)}` }),
    /webhook secret is not configured/,
  );
});

test("handleWebhook rejects unsupported event types", async () => {
  const rawBody = JSON.stringify({ type: "InvoiceCreated", invoiceId: "inv_1" });
  const gateway = new BtcpayGateway("key", async () => new Response("{}"), {
    webhookSecret: WEBHOOK_SECRET,
  });
  await assert.rejects(
    gateway.handleWebhook(rawBody, { "BTCPay-Sig": `sha256=${signBody(rawBody)}` }),
    /Unsupported BTCPay webhook event/,
  );
});
