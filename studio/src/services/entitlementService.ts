import { GatewayClient } from "./gatewayClient";

/**
 * What this machine may do, and how it comes to be allowed more.
 *
 * Two rules hold this file together, and both exist because a paid feature
 * gate is the kind of code that quietly rots into a lie:
 *
 *   1. **Nothing here decides anything.** The plan, the capability list, the
 *      labels and the prices all arrive from the gateway, which gets the
 *      capability half from `licence/entitlements.js` and the price half from
 *      the billing service. A feature list typed into a component is a list
 *      that stops matching the product the first time a plan changes.
 *   2. **A failure is never an upgrade prompt.** Every read here answers
 *      `null` when the gateway is unreachable, and the panel shows nothing
 *      rather than telling an offline Pro subscriber they are on Free.
 *
 * The session token lives in the gateway, never in the renderer, so checkout
 * and order polling are proxied rather than called directly.
 */

/** One thing the product knows how to gate, as the upgrade screen shows it. */
export interface Capability {
  id: string;
  label: string;
  description: string;
}

export interface EntitlementPlan {
  id: string;
  label: string;
  capabilities: string[];
}

export interface Entitlement {
  plan: string;
  planLabel: string;
  capabilities: string[];
  /** `valid`, `grace` (stale but still honoured), or `none`. */
  state: string;
  /** Why it is not `valid` — `no_licence`, `stale`, `expired`, a verify failure. */
  reason: string | null;
  /** Unix seconds. */
  expiresAt?: number | null;
  refreshAfter?: number | null;
  signedIn: boolean;
  /** False when this build was never pointed at a billing service. */
  billingConfigured: boolean;
  catalog: Record<string, Omit<Capability, "id">>;
  plans: EntitlementPlan[];
}

/** The device-code flow, as the panel has to render it. */
export interface SignInStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export type SignInPoll = { status: "granted"; entitlement: Entitlement } | { status: string; entitlement: null };

export interface Price {
  id: string;
  rail: "stripe" | "lipia";
  interval: string;
  /** Minor units — cents, or Tanzanian shillings, which have none. */
  amount: number;
  currency: string;
}

export interface PurchasablePlan {
  id: string;
  label: string;
  blurb: string | null;
  capabilities: Capability[];
  prices: Price[];
}

export interface Order {
  id: string;
  status: "created" | "charging" | "paid" | "failed" | "cancelled" | string;
  kind: string;
  plan: string;
  amount: number;
  currency: string;
  rail: string;
  failureReason: string | null;
}

/** Stripe hands back a page to open; Lipia hands back a prompt to watch. */
export type Checkout = { url: string; sessionId?: string } | { order: Order };

export class EntitlementError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "EntitlementError";
  }
}

/** The gateway's `{error:{code,message}}`, or a readable fallback. */
async function fail(response: Response): Promise<EntitlementError> {
  const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  return new EntitlementError(
    body?.error?.message || `The gateway answered ${response.status}.`,
    body?.error?.code || "ENTITLEMENT_CALL_FAILED",
  );
}

export class EntitlementService {
  /** Null on any failure — see the second rule at the top of this file. */
  public static async read(signal?: AbortSignal): Promise<Entitlement | null> {
    try {
      const response = await GatewayClient.request("/api/entitlement", { method: "GET", signal });
      if (!response.ok) return null;
      return (await response.json()) as Entitlement;
    } catch {
      return null;
    }
  }

  /**
   * Ask the service for a fresh licence.
   *
   * The gateway returns the cached entitlement when the service is unreachable,
   * so a refresh that fails is a no-op rather than a downgrade.
   */
  public static async refresh(signal?: AbortSignal): Promise<Entitlement | null> {
    try {
      const response = await GatewayClient.request("/api/entitlement/refresh", { method: "POST", signal });
      if (!response.ok) return null;
      return (await response.json()) as Entitlement;
    } catch {
      return null;
    }
  }

  /**
   * Begin a device-code sign-in.
   *
   * Throws rather than returning null: the user pressed a button, so silence
   * would leave them staring at an unchanged panel wondering what happened.
   */
  public static async startSignIn(deviceName?: string, signal?: AbortSignal): Promise<SignInStart> {
    const response = await GatewayClient.request("/api/entitlement/sign-in", {
      method: "POST",
      body: JSON.stringify(deviceName ? { deviceName } : {}),
      signal,
    });
    if (!response.ok) throw await fail(response);
    return (await response.json()) as SignInStart;
  }

  /** `pending` until the code is claimed, then `granted` with the entitlement. */
  public static async pollSignIn(deviceCode: string, signal?: AbortSignal): Promise<SignInPoll> {
    const response = await GatewayClient.request("/api/entitlement/sign-in/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode }),
      signal,
    });
    if (!response.ok) throw await fail(response);
    const body = (await response.json()) as { status: string } & Partial<Entitlement>;
    if (body.status !== "granted") return { status: body.status, entitlement: null };
    const { status: _status, ...entitlement } = body;
    return { status: "granted", entitlement: entitlement as Entitlement };
  }

  public static async signOut(signal?: AbortSignal): Promise<Entitlement | null> {
    try {
      const response = await GatewayClient.request("/api/entitlement/sign-out", { method: "POST", signal });
      if (!response.ok) return null;
      return (await response.json()) as Entitlement;
    } catch {
      return null;
    }
  }

  /** What is for sale. Public — no sign-in needed to see a price. */
  public static async plans(signal?: AbortSignal): Promise<PurchasablePlan[] | null> {
    try {
      const response = await GatewayClient.request("/api/entitlement/plans", { method: "GET", signal });
      if (!response.ok) return null;
      const body = (await response.json()) as { plans?: PurchasablePlan[] };
      return Array.isArray(body.plans) ? body.plans : [];
    } catch {
      return null;
    }
  }

  /** Start a payment. `msisdn` is required by the mobile-money rail only. */
  public static async checkout(rail: "stripe" | "lipia", priceId: string, msisdn?: string): Promise<Checkout> {
    const response = await GatewayClient.request("/api/entitlement/checkout", {
      method: "POST",
      body: JSON.stringify({ rail, priceId, ...(msisdn ? { msisdn } : {}) }),
    });
    if (!response.ok) throw await fail(response);
    return (await response.json()) as Checkout;
  }

  /** How a mobile-money prompt is going. Reconciled on read by the service. */
  public static async order(orderId: string, signal?: AbortSignal): Promise<Order | null> {
    try {
      const response = await GatewayClient.request(`/api/entitlement/order/${encodeURIComponent(orderId)}`, {
        method: "GET",
        signal,
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { order?: Order };
      return body.order ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * Minor units to something a person reads.
 *
 * Currencies without a minor unit are the reason this is not `/100`: TZS is
 * quoted in whole shillings, and dividing it would price Pro at one hundredth
 * of what the service is about to charge.
 */
const ZERO_DECIMAL = new Set(["TZS", "JPY", "KRW", "UGX", "RWF", "VND", "CLP", "ISK", "XOF", "XAF"]);

export function formatPrice(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const zeroDecimal = ZERO_DECIMAL.has(code);
  const value = zeroDecimal ? amount : amount / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: zeroDecimal ? 0 : 2,
      maximumFractionDigits: zeroDecimal ? 0 : 2,
    }).format(value);
  } catch {
    // An unknown ISO code is still a number worth showing.
    return `${value.toLocaleString()} ${code}`;
  }
}
