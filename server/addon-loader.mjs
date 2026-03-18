import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const addonsDir = path.resolve(__dirname, "addons");

/** @type {Map<string, { manifest: object, handler: Function }>} */
const addons = new Map();

async function loadAddons() {
  if (!fs.existsSync(addonsDir) || !fs.statSync(addonsDir).isDirectory()) {
    return;
  }

  for (const entry of fs.readdirSync(addonsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(addonsDir, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const mod = await import(`./addons/${entry.name}/index.mjs`);
      addons.set(manifest.name || entry.name, {
        manifest: {
          name: manifest.name || entry.name,
          label: manifest.label || entry.name,
          description: manifest.description || "",
        },
        handler: mod.handleRequest,
      });
      console.log(`Loaded addon: ${manifest.label || entry.name}`);
    } catch (err) {
      console.error(`Failed to load addon "${entry.name}":`, err.message);
    }
  }
}

export function getAddonManifests() {
  return Array.from(addons.values()).map((a) => a.manifest);
}

export async function routeAddonRequest(request, response, name, subpath, searchParams) {
  const addon = addons.get(name);
  if (!addon) return false;
  await addon.handler(request, response, subpath, searchParams);
  return true;
}

await loadAddons();
