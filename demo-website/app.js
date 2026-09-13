document.addEventListener("DOMContentLoaded", () => {
  let orderTotal = 0.00;
  const totalDisplay = document.getElementById("order-total");
  const buttons = document.querySelectorAll(".add-btn");

  buttons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const card = e.target.closest(".menu-card");
      const name = card.dataset.name;
      const price = parseFloat(card.dataset.price);

      orderTotal += price;
      totalDisplay.innerText = "€" + orderTotal.toFixed(2);

      // Micro-animation feedback
      btn.innerText = "✓ Added!";
      btn.style.background = "var(--gold)";
      btn.style.color = "#000";

      setTimeout(() => {
        btn.innerText = "+ Add to Order";
        btn.style.background = "";
        btn.style.color = "";
      }, 900);
    });
  });
});