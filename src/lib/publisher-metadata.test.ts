import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

function wingetLocaleManifests(): string[] {
  const base = path.join(root, "packaging/winget/manifests");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".locale.en-US.yaml")) found.push(full);
    }
  };
  walk(base);
  return found;
}

describe("publisher metadata", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));

  it("Windows installers and binaries name Corpse as publisher", () => {
    // bundle.publisher feeds the NSIS "Publisher" registry value, the MSI
    // Manufacturer and the executable CompanyName.
    expect(conf.bundle.publisher).toBe("Corpse");
    expect(conf.bundle.copyright).toMatch(/Corpse/);
  });

  it("the copyright line still credits the original authors", () => {
    expect(conf.bundle.copyright).toMatch(/OpenSelena/);
  });

  it("the winget manifest draft names Corpse as publisher", () => {
    const manifests = wingetLocaleManifests();
    expect(manifests.length).toBeGreaterThan(0);
    for (const file of manifests) {
      const text = fs.readFileSync(file, "utf8");
      expect(text).toMatch(/^Publisher: Corpse$/m);
      expect(text).toMatch(/^Copyright: .*OpenSelena/m);
    }
  });

  it("README and LICENSE keep the original credits and the GPL", () => {
    expect(read("README.md")).toMatch(/OpenSelena/);
    expect(read("LICENSE")).toMatch(/GNU GENERAL PUBLIC LICENSE/);
  });

  it("the About page credits only the fork maintainer", () => {
    const about = read("src/routes/about/+page.svelte");
    expect(about).toMatch(/@PixelStack1/);
    expect(about).toMatch(/github\.com\/PixelStack1\/omniget/);
    expect(about).not.toMatch(/OpenSelena/i);
    expect(about).not.toMatch(/t\.me\//);
    expect(about).not.toMatch(/about\.(based_on|telegram_button)/);
    expect(read("src/routes/about/project/+page.svelte")).toMatch(/PixelStack1\/omniget/);
    expect(read("src/routes/about/project/+page.svelte")).not.toMatch(/OpenSelena/i);
    expect(read("src/lib/i18n/keys.ts")).not.toMatch(/about\.(based_on|telegram_button)/);
    const files = fs.readdirSync(path.join(root, "src/lib/i18n")).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(12);
    for (const file of files) {
      const dict = JSON.parse(read(`src/lib/i18n/${file}`));
      expect(dict.about.credit, file).toMatch(/Corpse/);
      expect(dict.about.based_on, file).toBeUndefined();
      expect(dict.about.telegram_button, file).toBeUndefined();
      // The About section and the changelog shown under About stay free of it.
      expect(JSON.stringify(dict.about), file).not.toMatch(/OpenSelena/i);
      expect(JSON.stringify(dict.changelog), file).not.toMatch(/OpenSelena/i);
    }
    expect(JSON.parse(read("src/lib/i18n/en.json")).about.credit).toBe("Taken over and fully improved by Corpse");
    expect(JSON.parse(read("src/lib/i18n/fr.json")).about.credit).toBe("Repris et entièrement amélioré par Corpse");
  });
});
