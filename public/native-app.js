(function () {
  "use strict";

  const MAX_PDF_BYTES = 25 * 1024 * 1024;

  function capacitor() {
    return window.Capacitor || null;
  }

  function nativePlugin() {
    const bridge = capacitor();
    if (!bridge) return null;
    if (bridge.Plugins?.SumsnNative) return bridge.Plugins.SumsnNative;
    if (typeof bridge.registerPlugin === "function") {
      return bridge.registerPlugin("SumsnNative");
    }
    return null;
  }

  function isNativeIOS() {
    const bridge = capacitor();
    return Boolean(
      bridge?.isNativePlatform?.() &&
      bridge?.getPlatform?.() === "ios" &&
      nativePlugin()
    );
  }

  function showStatus(message, isError) {
    let status = document.getElementById("sumsnNativeStatus");
    if (!status) {
      status = document.createElement("div");
      status.id = "sumsnNativeStatus";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      Object.assign(status.style, {
        position: "fixed",
        zIndex: "2147483647",
        right: "max(16px, env(safe-area-inset-right))",
        bottom: "max(18px, env(safe-area-inset-bottom))",
        left: "max(16px, env(safe-area-inset-left))",
        maxWidth: "520px",
        margin: "auto",
        padding: "13px 16px",
        borderRadius: "14px",
        boxShadow: "0 16px 45px rgba(16, 24, 40, .22)",
        color: "#fff",
        font: "700 13px/1.7 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        textAlign: "center",
      });
      document.body.appendChild(status);
    }
    status.style.background = isError ? "#b42318" : "#087b59";
    status.textContent = message;
    status.hidden = false;
    window.clearTimeout(status._dismissTimer);
    status._dismissTimer = window.setTimeout(() => { status.hidden = true; }, 4200);
  }

  function enhanceNativeLabels() {
    if (!isNativeIOS()) return;
    document.documentElement.dataset.nativeApp = "ios";
    document.querySelectorAll("#labelButton, .history-label").forEach((element) => {
      if (element.textContent !== "مشاركة أو طباعة البوليصة") {
        element.textContent = "مشاركة أو طباعة البوليصة";
      }
      element.removeAttribute("target");
    });
    const payment = document.getElementById("payButton");
    if (payment) {
      if (payment.textContent !== "فتح الدفع الآمن") {
        payment.textContent = "فتح الدفع الآمن";
      }
      payment.removeAttribute("target");
    }
    document.querySelectorAll(".rate").forEach((rate) => {
      if (rate.querySelector(".native-share-quote")) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "book native-share-quote";
      button.textContent = "مشاركة العرض";
      button.style.marginTop = "8px";
      button.addEventListener("click", async () => {
        const summary = rate.innerText.replace(/\s+/g, " ").trim();
        try {
          await nativePlugin().shareText({
            text: `عرض شحن من SUMSN\n${summary}\n${location.origin}`,
          });
          await nativePlugin().impact({ style: "success" }).catch(() => {});
        } catch (error) {
          console.error("SUMSN quote sharing failed", error);
          showStatus("تعذر فتح مشاركة العرض.", true);
        }
      });
      rate.appendChild(button);
    });
  }

  function pdfFilename(anchor) {
    const order = new URL(anchor.href, location.href).searchParams.get("orderId") || "shipping-label";
    return `SUMSN-${String(order).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64)}.pdf`;
  }

  async function blobAsBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("PDF_READ_FAILED"));
      reader.onload = () => resolve(String(reader.result || "").split(",").pop() || "");
      reader.readAsDataURL(blob);
    });
  }

  async function shareShippingLabel(anchor) {
    showStatus("جاري تجهيز البوليصة للطباعة والمشاركة…", false);
    const response = await fetch(anchor.href, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/pdf" },
    });
    if (!response.ok) throw new Error(`PDF_HTTP_${response.status}`);
    const blob = await response.blob();
    if (!blob.size || blob.size > MAX_PDF_BYTES) throw new Error("PDF_SIZE_INVALID");
    const base64 = await blobAsBase64(blob);
    await nativePlugin().sharePdf({ base64, filename: pdfFilename(anchor) });
    await nativePlugin().impact({ style: "success" }).catch(() => {});
    showStatus("البوليصة جاهزة للحفظ أو الطباعة أو المشاركة.", false);
  }

  async function openSecurePayment(anchor) {
    await nativePlugin().openPayment({ url: anchor.href });
  }

  document.addEventListener("click", async (event) => {
    if (!isNativeIOS()) return;
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    if (!anchor?.href) return;

    const isLabel = anchor.id === "labelButton" || anchor.classList.contains("history-label");
    const isPayment = anchor.id === "payButton";
    if (!isLabel && !isPayment) return;

    event.preventDefault();
    try {
      if (isPayment) await openSecurePayment(anchor);
      else await shareShippingLabel(anchor);
    } catch (error) {
      console.error("SUMSN native action failed", error);
      await nativePlugin()?.impact({ style: "error" }).catch(() => {});
      showStatus(
        isPayment
          ? "تعذر فتح نافذة الدفع الآمن. حاول مرة أخرى."
          : "تعذر تجهيز البوليصة داخل التطبيق. افتحها من لوحة الحساب وحاول مجددًا.",
        true
      );
    }
  }, true);

  document.addEventListener("DOMContentLoaded", () => {
    enhanceNativeLabels();
    if (isNativeIOS()) {
      const observer = new MutationObserver(enhanceNativeLabels);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  });
})();
