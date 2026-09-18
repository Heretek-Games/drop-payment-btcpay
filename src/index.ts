import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PaymentGateway,
  PaymentIntentRequest,
  PaymentIntentResult,
  PaymentWebhookResult,
  PluginContext,
  PluginStorage,
  ServerPlugin,
} from "@droposs/plugin-sdk";

export interface HttpRequest {
  (url: string, init?: RequestInit): Promise<Response>;
}

/** Thrown when a BTCPay webhook cannot be authenticated. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export interface BtcpayGatewayOptions {
  /**
   * BTCPay Server API base, e.g. `https://btcpay.example.org/api/v1`.
   * There is deliberately no default: the gateway refuses to build API calls
   * until the host configures a real deployment URL.
   */
  apiBaseUrl?: string;
  /**
   * BTCPay store id. Invoices are created at
   * `{apiBaseUrl}/stores/{storeId}/invoices`; without it checkout is rejected.
   */
  storeId?: string;
  /** Webhook signing secret used for the `BTCPay-Sig` header. */
  webhookSecret?: string;
}

/**
 * Storage keys the host may use to configure the gateway; environment
 * variables (`BTCPAY_BASE_URL`, `BTCPAY_STORE_ID`, `BTCPAY_WEBHOOK_SECRET`) are
 * the fallback.
 */
export const BTCPAY_STORAGE_KEYS = {
  apiBaseUrl: "apiBaseUrl",
  storeId: "storeId",
  webhookSecret: "webhookSecret",
} as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function normalizeApiBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("BTCPay Server base URL is not a valid absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("BTCPay Server base URL must use http or https");
  }
  return trimmed;
}

/** Resolve gateway configuration from plugin storage, then the environment. */
export async function resolveBtcpayConfig(
  storage: Pick<PluginStorage, "get">,
  env: Record<string, string | undefined> = process.env,
): Promise<BtcpayGatewayOptions & { apiKey?: string }> {
  const [storedBaseUrl, storedStoreId, storedWebhookSecret] = await Promise.all([
    storage.get<string>(BTCPAY_STORAGE_KEYS.apiBaseUrl),
    storage.get<string>(BTCPAY_STORAGE_KEYS.storeId),
    storage.get<string>(BTCPAY_STORAGE_KEYS.webhookSecret),
  ]);
  return {
    apiBaseUrl:
      storedBaseUrl ?? env["BTCPAY_BASE_URL"] ?? undefined,
    storeId: storedStoreId ?? env["BTCPAY_STORE_ID"] ?? undefined,
    apiKey: env["BTCPAY_API_KEY"],
    webhookSecret:
      storedWebhookSecret ?? env["BTCPAY_WEBHOOK_SECRET"] ?? undefined,
  };
}

/**
 * The host must pass the raw webhook body; BTCPay signs the exact bytes it
 * sent. Strings and byte arrays are used verbatim, anything else is
 * re-serialized as a best effort.
 */
function toRawBody(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload instanceof Uint8Array) return new TextDecoder().decode(payload);
  if (payload instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(payload));
  }
  return JSON.stringify(payload ?? {});
}

export interface VerifyBtcpaySignatureOptions {
  rawBody: string;
  /** `BTCPay-Sig` header, e.g. `sha256=<hex>` (bare hex is also accepted). */
  signatureHeader: string | undefined;
  secret: string;
}

/**
 * Verify the `BTCPay-Sig` header: HMAC-SHA256 over the raw body with the
 * webhook secret, compared in constant time. Fails closed when no secret is
 * configured.
 */
export function verifyBtcpaySignature(
  options: VerifyBtcpaySignatureOptions,
): void {
  const { rawBody, signatureHeader, secret } = options;
  if (secret.length === 0) {
    throw new WebhookVerificationError(
      "BTCPay webhook secret is not configured",
    );
  }
  if (!signatureHeader) {
    throw new WebhookVerificationError("Missing BTCPay-Sig header");
  }
  const provided = signatureHeader.trim().replace(/^sha256=/i, "");
  if (provided.length === 0 || !/^[0-9a-f]+$/i.test(provided)) {
    throw new WebhookVerificationError("BTCPay-Sig header is malformed");
  }
  const expected = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
  const providedBytes = Buffer.from(provided, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (
    providedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(providedBytes, expectedBytes)
  ) {
    throw new WebhookVerificationError(
      "BTCPay webhook signature verification failed",
    );
  }
}

function mapIntentStatus(status: unknown): PaymentIntentResult["status"] {
  switch (typeof status === "string" ? status.toLowerCase() : status) {
    case "settled":
    case "complete":
    case "completed":
    case "paid":
      return "succeeded";
    case "expired":
    case "invalid":
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

function mapEventStatus(
  type: string | undefined,
  event: Record<string, unknown>,
): PaymentWebhookResult["status"] {
  switch (type) {
    case "InvoiceSettled":
    case "InvoicePaymentSettled":
    case "InvoicePaidInFull":
      return "succeeded";
    case "InvoiceExpired":
    case "InvoiceInvalid":
      return "failed";
    case "InvoiceRefunded":
      return "refunded";
    default:
      break;
  }
  const status = firstString(event["status"]);
  switch (status?.toLowerCase()) {
    case "settled":
    case "complete":
    case "completed":
    case "paid":
    case "confirmed":
      return "succeeded";
    case "expired":
    case "invalid":
    case "failed":
      return "failed";
    case "refunded":
      return "refunded";
    default:
      throw new Error(
        `Unsupported BTCPay webhook event: ${type ?? status ?? "unknown"}`,
      );
  }
}

function parsePosData(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

/** BTCPay Server gateway adapter. */
export class BtcpayGateway implements PaymentGateway {
  id = "btcpay";
  name = "BTCPay Server";

  constructor(
    private readonly secretKey: string | undefined,
    private readonly fetchFn: HttpRequest,
    private readonly options: BtcpayGatewayOptions = {},
  ) {}

  private requireApiBaseUrl(): string {
    let apiBaseUrl: string | undefined;
    try {
      apiBaseUrl = normalizeApiBaseUrl(this.options.apiBaseUrl);
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : "BTCPay Server base URL is invalid",
      );
    }
    if (!apiBaseUrl) {
      throw new Error(
        "BTCPay Server base URL is not configured (set BTCPAY_BASE_URL or the plugin apiBaseUrl storage key)",
      );
    }
    return apiBaseUrl;
  }

  private requireStoreId(): string {
    const storeId = this.options.storeId?.trim();
    if (!storeId) {
      throw new Error(
        "BTCPay Server store id is not configured (set BTCPAY_STORE_ID or the plugin storeId storage key)",
      );
    }
    return storeId;
  }

  async createPaymentIntent(
    req: PaymentIntentRequest,
  ): Promise<PaymentIntentResult> {
    if (!this.secretKey) {
      throw new Error("BTCPay Server API key is not configured");
    }
    if (!Number.isFinite(req.amount) || req.amount <= 0) {
      throw new Error(
        `Invoice amount must be a positive finite number, received: ${req.amount}`,
      );
    }
    const apiBaseUrl = this.requireApiBaseUrl();
    const storeId = this.requireStoreId();
    const response = await this.fetchFn(
      `${apiBaseUrl}/stores/${encodeURIComponent(storeId)}/invoices`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderId: req.orderId,
          amount: req.amount,
          currency: req.currency,
          metadata: {
            orderId: req.orderId,
            ...(req.metadata ?? {}),
          },
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`BTCPay Server checkout failed: ${response.status}`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    return {
      intentId: String(payload["id"] ?? req.orderId),
      clientSecret: firstString(payload["clientSecret"], payload["client_secret"]),
      checkoutUrl: firstString(
        payload["checkoutLink"],
        payload["checkoutUrl"],
        payload["url"],
      ),
      status: mapIntentStatus(payload["status"]),
    };
  }

  async handleWebhook(
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<PaymentWebhookResult> {
    const rawBody = toRawBody(payload);
    verifyBtcpaySignature({
      rawBody,
      signatureHeader: headerValue(headers, "btcpay-sig"),
      secret: this.options.webhookSecret ?? "",
    });
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new WebhookVerificationError("Malformed BTCPay webhook payload");
    }
    const metadata = asRecord(event["metadata"]) ?? {};
    const posData = parsePosData(event["posData"] ?? event["pos_data"]);
    return {
      orderId:
        firstString(
          metadata["orderId"],
          metadata["order_id"],
          posData?.["orderId"],
          posData?.["order_id"],
          event["orderId"],
        ) ?? "",
      status: mapEventStatus(firstString(event["type"]), event),
      transactionId:
        firstString(
          event["invoiceId"],
          event["invoice_id"],
          event["id"],
          event["deliveryId"],
          event["delivery_id"],
        ) ?? "",
      payload: event,
    };
  }
}

export default class BtcpayPlugin implements ServerPlugin {
  metadata = {
    id: "drop-payment-btcpay",
    name: "BTCPay Server",
    version: "0.1.0",
    apiVersion: 2,
    capabilities: ["commerce:payment" as const, "storage" as const, "network" as const],
  };

  async init(ctx: PluginContext): Promise<void> {
    const config = await resolveBtcpayConfig(ctx.storage);
    ctx.registerPaymentGateway(
      new BtcpayGateway(config.apiKey, ctx.fetch.bind(ctx) as HttpRequest, {
        apiBaseUrl: config.apiBaseUrl,
        storeId: config.storeId,
        webhookSecret: config.webhookSecret,
      }),
    );
    ctx.logger.info(
      `BTCPay Server gateway registered${config.apiBaseUrl ? "" : " (no base URL configured)"}`,
    );
    if (!config.apiBaseUrl) {
      ctx.logger.warn(
        "BTCPay Server base URL is not configured; checkout calls will be rejected",
      );
    }
    if (!config.storeId) {
      ctx.logger.warn(
        "BTCPay Server store id is not configured; checkout calls will be rejected",
      );
    }
    if (!config.webhookSecret) {
      ctx.logger.warn(
        "BTCPay webhook secret is not configured; webhook calls will be rejected",
      );
    }
  }
}
