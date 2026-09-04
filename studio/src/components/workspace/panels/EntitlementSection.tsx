import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, ExternalLink, LoaderCircle, Lock, Smartphone, CreditCard } from "lucide-react";
import {
  EntitlementError,
  EntitlementService,
  formatPrice,
  type Entitlement,
  type Order,
  type Price,
  type PurchasablePlan,
  type SignInStart,
} from "../../../services/entitlementService";
import { Badge, Button, InlineCode, Input } from "../../ui";

/**
 * The Teminali plan: what this machine may do, and how it comes to be allowed
 * more.
 *
 * It sits above the Claude Code / Codex plan headroom in the same panel, and
 * the two are deliberately labelled apart. They answer different questions —
 * this one is "what did you buy from us", that one is "what is left of the
 * subscription you bought from Anthropic" — and a reader who conflates them
 * ends up believing an upgrade here would raise a limit there.
 *
 * ## Three rules this component follows
 *
 * **The feature list is never written here.** `catalog` arrives from the
 * gateway, which reads `licence/entitlements.js`. A list typed into JSX is a
 * list that silently stops matching what the gates actually enforce.
 *
 * **Whether to offer an upgrade at all is a capability question.** It is not
 * `plan !== "pro"`. The section offers a paid plan exactly when some plan on
 * sale carries a capability this entitlement lacks, so adding Team or a trial
 * needs no edit here, and a lifetime Pro user is never shown an upsell for
 * something they already own.
 *
 * **A failure is never an upgrade prompt.** Every read fails to null, and the
 * whole section disappears rather than telling an offline subscriber they are
 * on Free.
 */

/** Poll no faster than the service asked, and never faster than every 2s. */
const MIN_POLL_MS = 2_000;
/** A mobile-money prompt is a person picking up a handset. */
const ORDER_POLL_MS = 4_000;

/** What the state means to somebody who is not holding the source. */
function stateNote(entitlement: Entitlement): { tone: "amber" | "rose" | null; text: string | null } {
  if (entitlement.state === "grace") {
    return { tone: "amber", text: "Your licence is stale. Connect to the internet to renew it — nothing is locked yet." };
  }
  if (entitlement.state === "none" && entitlement.reason === "expired") {
    return { tone: "rose", text: "Your licence expired. Sign in again, or renew, to restore the paid lanes." };
  }
  if (entitlement.state === "none" && entitlement.reason && entitlement.reason !== "no_licence") {
    // A verify failure is the one case worth naming exactly: it usually means
    // the licence was signed by a key this build does not carry, which is a
    // release problem and not something the user can fix by paying again.
    return { tone: "rose", text: `This licence could not be verified (${entitlement.reason}).` };
  }
  return { tone: null, text: null };
}

/** One capability, held or not. The lock is the whole message. */
const CapabilityRow: React.FC<{ label: string; description: string; held: boolean }> = ({ label, description, held }) => (
  <div className="flex items-start gap-2" title={description}>
    {held ? (
      <Check size={12} className="text-success flex-shrink-0 mt-[2px]" />
    ) : (
      <Lock size={11} className="text-ink-disabled flex-shrink-0 mt-[3px]" />
    )}
    <div className="min-w-0">
      <div className={`text-2xs truncate ${held ? "text-ink-body" : "text-ink-disabled"}`}>{label}</div>
      {!held && <div className="text-3xs text-ink-soft leading-relaxed">{description}</div>}
    </div>
  </div>
);

/** The device-code panel. The code is the secret; the URL is not. */
const SignInFlow: React.FC<{ start: SignInStart; note: string | null }> = ({ start, note }) => (
  <div className="space-y-2 pt-0.5">
    <p className="text-3xs text-ink-soft leading-relaxed">
      Open the page below and enter this code. This window keeps checking until you finish.
    </p>
    <div className="flex items-center gap-2">
      <InlineCode className="text-sm tracking-[0.2em] tabular-nums">{start.userCode}</InlineCode>
      <Button
        size="xs"
        variant="secondary"
        icon={<ExternalLink size={11} />}
        onClick={() => window.open(start.verificationUrl, "_blank", "noopener")}
      >
        Open page
      </Button>
      <LoaderCircle size={12} className="animate-spin text-ink-disabled" />
    </div>
    {note && <p className="text-3xs text-danger leading-relaxed">{note}</p>}
  </div>
);

/** One price, as a button. The rail is on the button because it changes what happens next. */
const PriceButton: React.FC<{ price: Price; busy: boolean; onPick: () => void }> = ({ price, busy, onPick }) => (
  <Button
    size="xs"
    variant={price.rail === "stripe" ? "primary" : "secondary"}
    loading={busy}
    disabled={busy}
    icon={price.rail === "stripe" ? <CreditCard size={11} /> : <Smartphone size={11} />}
    onClick={onPick}
  >
    {formatPrice(price.amount, price.currency)}
    <span className="opacity-70">/{price.interval}</span>
  </Button>
);

export const EntitlementSection: React.FC = () => {
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [signIn, setSignIn] = useState<SignInStart | null>(null);
  const [plans, setPlans] = useState<PurchasablePlan[] | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [msisdn, setMsisdn] = useState("");
  const [pendingPrice, setPendingPrice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void EntitlementService.read(controller.signal).then((next) => {
      if (!controller.signal.aborted) setEntitlement(next);
    });
    return () => controller.abort();
  }, []);

  /* ── The device-code poll ──────────────────────────────────────────────
     Runs only while a sign-in is open, and stops on the first definite
     answer. `denied` and `expired` are answers, not errors: the user closed
     the page, or waited too long, and both want the button back. So is a
     404 `UNKNOWN_DEVICE_CODE` — see the catch below. */
  useEffect(() => {
    if (!signIn) return;
    let cancelled = false;
    const interval = Math.max(MIN_POLL_MS, signIn.interval * 1000);
    const deadline = Date.now() + signIn.expiresIn * 1000;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() > deadline) {
        setSignIn(null);
        setNote("That code expired. Start again.");
        return;
      }
      try {
        const result = await EntitlementService.pollSignIn(signIn.deviceCode);
        if (cancelled) return;
        if (result.status === "granted" && result.entitlement) {
          setEntitlement(result.entitlement);
          setSignIn(null);
          setNote(null);
          return;
        }
        if (result.status === "denied" || result.status === "expired") {
          setSignIn(null);
          setNote(result.status === "denied" ? "That sign-in was denied." : "That code expired. Start again.");
          return;
        }
      } catch (error) {
        // A code the service has never heard of is as definite as `denied` —
        // it will not start working on the next tick, and polling on leaves
        // the user watching a dead sign-in until the deadline rather than
        // getting the button back.
        if (error instanceof EntitlementError && error.code === "UNKNOWN_DEVICE_CODE") {
          setSignIn(null);
          setNote("That sign-in is no longer valid. Start again.");
          return;
        }
        // Any other failed poll is usually the network, not a refusal. Keep
        // polling: giving up here would strand a user whose page succeeded.
        setNote(error instanceof Error ? error.message : "The sign-in check failed.");
      }
      timer = setTimeout(() => void tick(), interval);
    };

    let timer = setTimeout(() => void tick(), interval);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [signIn]);

  /* ── The mobile-money poll ─────────────────────────────────────────────
     A charge is a prompt on a handset, so this runs for as long as the order
     is unsettled. `paid` refreshes the licence, because the money landing is
     exactly the moment the entitlement changed underneath us. */
  useEffect(() => {
    if (!order || (order.status !== "created" && order.status !== "charging")) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const next = await EntitlementService.order(order.id);
      if (cancelled || !next) {
        timer = setTimeout(() => void tick(), ORDER_POLL_MS);
        return;
      }
      setOrder(next);
      if (next.status === "paid") {
        const refreshed = await EntitlementService.refresh();
        if (!cancelled && refreshed) {
          setEntitlement(refreshed);
          setPlans(null);
        }
        return;
      }
      if (next.status === "created" || next.status === "charging") timer = setTimeout(() => void tick(), ORDER_POLL_MS);
    };
    let timer = setTimeout(() => void tick(), ORDER_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [order]);

  const beginSignIn = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      setSignIn(await EntitlementService.startSignIn());
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Sign-in could not be started.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const openPlans = useCallback(async () => {
    setBusy(true);
    setNote(null);
    const next = await EntitlementService.plans();
    if (!mounted.current) return;
    setPlans(next ?? []);
    if (next === null) setNote("The price list could not be loaded.");
    setBusy(false);
  }, []);

  const buy = useCallback(
    async (price: Price) => {
      setPendingPrice(price.id);
      setNote(null);
      try {
        const result = await EntitlementService.checkout(price.rail, price.id, price.rail === "lipia" ? msisdn : undefined);
        if (!mounted.current) return;
        if ("url" in result) {
          // The card rail finishes in a browser. Nothing to poll: the webhook
          // lands while the user is still reading the receipt, so the honest
          // instruction is to come back and refresh.
          window.open(result.url, "_blank", "noopener");
          setNote("Finish the payment in your browser, then refresh.");
        } else {
          setOrder(result.order);
        }
      } catch (error) {
        setNote(error instanceof Error ? error.message : "That payment could not be started.");
      } finally {
        if (mounted.current) setPendingPrice(null);
      }
    },
    [msisdn],
  );

  const refresh = useCallback(async () => {
    setBusy(true);
    setNote(null);
    const next = await EntitlementService.refresh();
    if (!mounted.current) return;
    if (next) setEntitlement(next);
    setBusy(false);
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    const next = await EntitlementService.signOut();
    if (!mounted.current) return;
    if (next) setEntitlement(next);
    setPlans(null);
    setSignIn(null);
    setOrder(null);
    setBusy(false);
  }, []);

  // The gateway did not answer. The panel above already says so; a second
  // notice, or worse a "Free" badge, would be noise or a lie.
  if (!entitlement) return null;

  const held = new Set(entitlement.capabilities);
  // Capability-driven, not plan-name driven. See the header comment.
  const upgradable = entitlement.plans.some((plan) => plan.capabilities.some((capability) => !held.has(capability)));
  const status = stateNote(entitlement);
  const lipiaPending = order !== null && (order.status === "created" || order.status === "charging");
  const catalogue = Object.entries(entitlement.catalog);
  const forSale = (plans ?? []).filter((plan) => plan.capabilities.some((capability) => !held.has(capability.id)));

  return (
    <section className="rounded-lg bg-surface-sunken border border-edge px-3 py-2.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs text-ink-muted flex-shrink-0">Teminali plan</span>
        <div className="flex items-center gap-1.5">
          {entitlement.state === "grace" && (
            <Badge size="xs" variant="amber">
              Stale
            </Badge>
          )}
          <Badge size="xs" variant={upgradable ? "neutral" : "emerald"}>
            {entitlement.planLabel}
          </Badge>
        </div>
      </div>

      <div className="space-y-1.5">
        {catalogue.map(([id, capability]) => (
          <CapabilityRow key={id} label={capability.label} description={capability.description} held={held.has(id)} />
        ))}
      </div>

      {status.text && (
        <p className={`text-3xs leading-relaxed ${status.tone === "rose" ? "text-danger" : "text-warning"}`}>{status.text}</p>
      )}

      {/* ── What to do about it ────────────────────────────────────────────
          A build with no billing service is a legitimate configuration — the
          free lanes need no account — so it gets an explanation rather than a
          button that would fail. */}
      {!entitlement.billingConfigured ? (
        <div className="space-y-2 pt-0.5">
          <p className="text-3xs text-ink-disabled leading-relaxed">
            This build has no billing service configured, so the free lanes are all it can grant.
          </p>
          {/* A licence outliving the address it was fetched from is rare but
              real — the variable can be unset after a sign-in — and leaving no
              way out would strand the account on the machine. */}
          {entitlement.signedIn && (
            <Button size="xs" variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          )}
        </div>
      ) : signIn ? (
        <SignInFlow start={signIn} note={note} />
      ) : (
        <div className="space-y-2 pt-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {!entitlement.signedIn && (
              <Button size="xs" variant="primary" loading={busy} onClick={() => void beginSignIn()}>
                Sign in
              </Button>
            )}
            {entitlement.signedIn && upgradable && plans === null && (
              <Button size="xs" variant="primary" loading={busy} onClick={() => void openPlans()}>
                Upgrade
              </Button>
            )}
            {entitlement.signedIn && (
              <Button size="xs" variant="ghost" loading={busy} onClick={() => void refresh()}>
                Refresh
              </Button>
            )}
            {entitlement.signedIn && (
              <Button size="xs" variant="ghost" onClick={() => void signOut()}>
                Sign out
              </Button>
            )}
          </div>

          {/* ── The price list ───────────────────────────────────────────
              Only plans carrying something this entitlement lacks are shown:
              a plan the user already out-ranks is not an offer. */}
          {plans !== null && (
            <div className="space-y-2 pt-0.5">
              {forSale.length === 0 && <p className="text-3xs text-ink-disabled">Nothing is on sale for this build yet.</p>}
              {forSale.map((plan) => (
                <div key={plan.id} className="space-y-1.5">
                  <div className="text-2xs text-ink-body">{plan.label}</div>
                  {plan.blurb && <div className="text-3xs text-ink-soft leading-relaxed">{plan.blurb}</div>}
                  {plan.prices.some((price) => price.rail === "lipia") && (
                    <Input
                      value={msisdn}
                      onChange={(event) => setMsisdn(event.target.value)}
                      placeholder="07xx xxx xxx — for mobile money"
                      inputMode="tel"
                    />
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {plan.prices.map((price) => (
                      <PriceButton
                        key={price.id}
                        price={price}
                        busy={pendingPrice === price.id}
                        onPick={() => void buy(price)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* The handset is where the rest of this happens, so say so. */}
          {lipiaPending && (
            <div className="flex items-center gap-2 text-3xs text-ink-soft">
              <LoaderCircle size={11} className="animate-spin flex-shrink-0" />
              Check your phone and approve the payment prompt.
            </div>
          )}
          {order?.status === "failed" && (
            <p className="text-3xs text-danger leading-relaxed">
              That payment failed{order.failureReason ? ` — ${order.failureReason}` : ""}. Nothing was charged.
            </p>
          )}
          {note && <p className="text-3xs text-ink-soft leading-relaxed">{note}</p>}
        </div>
      )}
    </section>
  );
};
