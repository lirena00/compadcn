import { readFileSync } from "node:fs";

interface PackageInfo {
  name: string;
  version: string;
  description: string;
}

export const packageInfo: Readonly<PackageInfo> = Object.freeze(
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as PackageInfo
);
