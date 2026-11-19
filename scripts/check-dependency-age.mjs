// Fails if package-lock.json pins any package version published less than
// MIN_DAYS ago. `min-release-age` in .npmrc only applies when npm resolves a
// new version; this catches lockfile entries that slipped in another way
// (older npm, hand edits, merges). Run with `npm run check:deps`.
import { readFileSync } from "node:fs";

const MIN_DAYS = 7;
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

const versions = new Map();
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path || !info.version || info.link) continue;
  const name = info.name ?? path.split("node_modules/").pop();
  versions.set(`${name}@${info.version}`, [name, info.version]);
}

const cutoff = Date.now() - MIN_DAYS * 864e5;
const problems = [];
const entries = [...versions.values()];
for (let i = 0; i < entries.length; i += 25) {
  await Promise.all(
    entries.slice(i, i + 25).map(async ([name, version]) => {
      const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
      if (!res.ok) return problems.push(`${name}@${version}: registry returned ${res.status}`);
      const published = (await res.json()).time?.[version];
      if (!published) problems.push(`${name}@${version}: no publish time`);
      else if (Date.parse(published) > cutoff) problems.push(`${name}@${version}: published ${published}`);
    }),
  );
}

if (problems.length) {
  console.error(`Dependencies younger than ${MIN_DAYS} days:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`All ${entries.length} locked packages are at least ${MIN_DAYS} days old.`);
