import { packageInfo } from "../lib/packageInfo.js";

export const renderTitle = () => {
  console.log(`${packageInfo.name} v${packageInfo.version}`);
};
