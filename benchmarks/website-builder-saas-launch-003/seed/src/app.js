import siteData from "./site-data.json" with { type: "json" };

export function renderMetrics(container, metrics = siteData.brand.verifiedMetrics) {
  if (!container) return;
  container.innerHTML = metrics.map(m => `
    <div class="metric-card">
      <div class="metric-value">${m.value}</div>
      <div class="metric-label">${m.label}</div>
    </div>
  `).join("");
}

export function renderPricing(container, isAnnual = false, pricing = siteData.pricing) {
  if (!container) return;
  const tiers = isAnnual ? pricing.annual : pricing.monthly;
  container.innerHTML = tiers.map(tier => `
    <div class="pricing-card" data-tier="${tier.id}">
      <h3>${tier.name}</h3>
      <div class="tier-price">${typeof tier.price === "number" ? "$" + tier.price + "/mo" : tier.price}</div>
      <div class="tier-events">${tier.events}</div>
      <button class="btn btn-primary" data-action="select-tier">Get Started</button>
    </div>
  `).join("");
}

export function setupLeadForm(form) {
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const emailInput = form.querySelector("#lead-email");
    const hpInput = form.querySelector("#lead-hp");
    const errorMsg = form.querySelector("#email-error");
    const statusMsg = form.querySelector("#form-status");

    // Honeypot check
    if (hpInput && hpInput.value.length > 0) {
      return; // Silent fail on bot spam
    }

    const email = emailInput?.value?.trim() ?? "";
    if (!email || !email.includes("@") || !email.includes(".")) {
      if (errorMsg) errorMsg.textContent = "Please enter a valid work email address.";
      return;
    }

    if (errorMsg) errorMsg.textContent = "";
    if (statusMsg) statusMsg.textContent = "Thank you! We will reach out shortly.";
    form.reset();
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    renderMetrics(document.getElementById("metrics-container"));
    const pricingContainer = document.getElementById("pricing-container");
    const billingSwitch = document.getElementById("billing-switch");
    renderPricing(pricingContainer, billingSwitch?.checked ?? false);
    billingSwitch?.addEventListener("change", (e) => {
      renderPricing(pricingContainer, e.target.checked);
    });
    setupLeadForm(document.getElementById("lead-form"));
  });
}
