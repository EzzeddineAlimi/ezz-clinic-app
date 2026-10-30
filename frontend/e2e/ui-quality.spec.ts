import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Contrast is checked against the computed input surface, not a guessed palette.
function luminance(rgb: string): number {
  const channels = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!channels) throw new Error("Unexpected computed CSS color: " + rgb);
  return [1, 2, 3].reduce((sum, i) => {
    const channel = Number(channels[i]!) / 255;
    const linear = channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][i - 1]!;
  }, 0);
}
function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill("web-fictional");
  await page.getByLabel("Identifiant personnel").fill("desk");
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  await expect(page.getByRole("heading", { name: "Le fil de la journée" })).toBeVisible();
}
async function assertVisibleFieldBoundary(page: Page, selector: string) {
  const fields = page.locator(selector);
  expect(await fields.count()).toBeGreaterThan(0);
  for (const field of await fields.all()) {
    const colors = await field.evaluate((el) => {
      const styles = getComputedStyle(el);
      return { border: styles.borderTopColor, surface: styles.backgroundColor };
    });
    expect(contrast(colors.border, colors.surface), selector).toBeGreaterThanOrEqual(3);
  }
}
async function assertTouchSize(page: Page, selector: string) {
  const controls = page.locator(selector);
  expect(await controls.count()).toBeGreaterThan(0);
  for (const control of await controls.all()) {
    const bounds = await control.boundingBox();
    expect(bounds, selector).not.toBeNull();
    expect(bounds!.height, selector).toBeGreaterThanOrEqual(44);
    expect(bounds!.width, selector).toBeGreaterThanOrEqual(44);
  }
}

test("UI quality: essential login and agenda fields have visible 3:1 boundaries", async ({ page }) => {
  await page.goto("/");
  await assertVisibleFieldBoundary(page, ".login-card input");
  await login(page);
  await assertVisibleFieldBoundary(page, ".dayboard-filters input, .dayboard-filters select");
});

test("UI quality: French and Arabic mobile controls retain 44px comfort targets", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertTouchSize(page, ".date-controls .icon-button");
  await assertTouchSize(page, ".filter-tabs button");
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await assertTouchSize(page, ".date-controls .icon-button");
  await assertTouchSize(page, ".filter-tabs button");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("UI quality: unavailable buttons do not falsely signal loading; field labels remain readable", async ({ page }) => {
  await page.goto("/");
  const state = await page.evaluate(() => {
    const button = document.createElement("button");
    button.disabled = true;
    button.textContent = "Unavailable";
    document.body.append(button);
    const cursor = getComputedStyle(button).cursor;
    button.remove();
    const label = document.querySelector(".login-card label");
    if (!label) throw new Error("Login field label not found");
    return { cursor, labelSize: parseFloat(getComputedStyle(label).fontSize) };
  });
  expect(state.cursor).toBe("not-allowed");
  expect(state.labelSize).toBeGreaterThanOrEqual(14);
});

// CSS zoom is a supplementary reflow stress case, not a substitute for real browser zoom review.
test("UI quality: French and Arabic 200% CSS zoom stress without horizontal page overflow", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => { document.body.style.zoom = "2"; });
  await expect(page.getByRole("heading", { name: "Le fil de la journée" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await test.info().attach("dayboard-fr-200pct-css-zoom", {
    body: await page.screenshot({ path: "../docs/images/sprint3b/dayboard-fr-200pct-css-zoom.png", animations: "disabled", fullPage: true }),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await test.info().attach("dayboard-ar-200pct-css-zoom", {
    body: await page.screenshot({ path: "../docs/images/sprint3b/dayboard-ar-200pct-css-zoom.png", animations: "disabled", fullPage: true }),
    contentType: "image/png",
  });
  await page.evaluate(() => { document.body.style.zoom = "1"; });
  await page.setViewportSize({ width: 640, height: 360 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await test.info().attach("dayboard-ar-landscape", {
    body: await page.screenshot({ path: "../docs/images/sprint3b/dayboard-ar-landscape.png", animations: "disabled", fullPage: true }),
    contentType: "image/png",
  });
});
