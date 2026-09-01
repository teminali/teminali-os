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
    const statusMsg = form.querySelector("#form-status");
    if (statusMsg) statusMsg.textContent = "Thanks — request received.";
    form.reset();
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    renderMetrics(document.getElementById("metrics-container"));
    const pricingContainer = document.getElementById("pricing-container");
    renderPricing(pricingContainer, false);
    setupLeadForm(document.getElementById("lead-form"));
  });
}
