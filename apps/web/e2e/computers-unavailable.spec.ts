import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("unavailable computers explain setup and open computer settings", async ({
  page,
}, testInfo) => {
  await signup(page, `computers-off-${Date.now()}@rakazo.test`, "password12", "Computers Off");
  await completeOnboarding(page);
  await page.route(/\/rpc\/(me|bootstrap|computer\/status)$/, async (route) => {
    const url = route.request().url();
    const response = await route.fetch();
    const body = await response.json();
    if (url.endsWith("/computer/status") && body.json) {
      body.json.state = "stopped";
      body.json.screenAvailable = false;
    } else if (url.endsWith("/me")) {
      body.json.sandboxProvider = "none";
      body.json.isDeploymentOwner = true;
    } else if (body.json?.me) {
      body.json.me.sandboxProvider = "none";
      body.json.me.isDeploymentOwner = true;
      if (body.json.thread?.computer) {
        body.json.thread.computer.state = "stopped";
        body.json.thread.computer.screenAvailable = false;
      }
    }
    await route.fulfill({ response, json: body });
  });
  await page.reload();

  await page.getByTitle("Agent computer").click();
  const preview = page.getByTestId("computer-preview");
  const hint = preview.getByTestId("computers-unavailable-hint");
  await expect(hint).toBeVisible();
  await expect(hint.getByText(/Computers are off/)).toBeVisible();
  await expect(hint.getByRole("button", { name: "Check again" })).toBeVisible();
  await expect(hint.getByRole("button", { name: "Open computer settings" })).toBeVisible();
  await expect(hint.getByRole("button", { name: "Copy .env example" })).toBeVisible();
  await expect(preview.getByTestId("computer-preview-open")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computers-unavailable-preview");

  await hint.getByRole("button", { name: "Check again" }).click();
  await expect(hint.getByText(/Computers are off/)).toBeVisible();
  await expect(hint.getByRole("button", { name: "Check again" })).toBeEnabled();

  await hint.getByRole("button", { name: "Open computer settings" }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toHaveAttribute("data-settings-section", "computer");
  await expect(settings.getByTestId("computers-setup-settings")).toBeVisible();
  await expect(settings.getByTestId("settings-nav-computer")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await captureScreenshot(page, testInfo, "computers-unavailable-settings");
});
